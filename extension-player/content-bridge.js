// Isolated world: reads settings from chrome.storage and hands them to the MAIN-world player script.
(() => {
  'use strict';
  // Errors in this script go to the Player's error log (settings, and the NAS folder).
  const reportError = (message, stack, where = 'bridge') => { try { chrome.runtime.sendMessage({ type: 'yhdx-error', where, message: String(message || '').slice(0, 300), stack: String(stack || '').slice(0, 800) }).catch(() => {}); } catch { /* cut off */ } };
  const ours = (stack) => /chrome-extension:\/\//.test(String(stack || ''));
  globalThis.addEventListener?.('error', (e) => { if (ours(e.error?.stack || e.filename)) reportError(e.message, e.error?.stack || `${e.filename}:${e.lineno}`); });
  globalThis.addEventListener?.('unhandledrejection', (e) => { if (ours(e.reason?.stack)) reportError(`unhandled: ${e.reason?.message || e.reason}`, e.reason?.stack); });

  // After the Player is updated or reloaded, this copy (still running in an already-open tab) is cut off from the
  // extension: every chrome.* call fails with "Extension context invalidated". Say once that the page needs a reload.
  let staleTold = false;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function stale() {
    if (staleTold) return;
    staleTold = true;
    window.postMessage({ __yhdx: 'stale' }, location.origin);
  }

  // To the service worker. Never throws: once cut off, Chrome throws right in the call (not a rejected promise).
  function send(msg) {
    if (!alive()) { stale(); return Promise.resolve(null); }
    try {
      return chrome.runtime.sendMessage(msg).catch(() => { if (!alive()) stale(); return null; });
    } catch {
      stale();
      return Promise.resolve(null);
    }
  }

  async function push() {
    if (!alive()) { stale(); return; }
    let settings;
    try { settings = await chrome.storage.sync.get(YHDX_DEFAULTS); } catch { if (!alive()) stale(); return; }
    window.postMessage(
      { __yhdx: 'settings', settings, captionCss: yhdxBuildPageCss(settings) },
      location.origin
    );
  }

  // MAIN-world script asks for lyrics (video without human-made captions); the service worker looks them up.
  async function lyrics(req) {
    const msg = {
      type: 'lyrics',
      videoId: String(req.videoId || ''),
      title: String(req.title || '').slice(0, 300),
      author: String(req.author || '').slice(0, 200),
      duration: Number(req.duration) || 0,
      exclude: (Array.isArray(req.exclude) ? req.exclude : []).map(String).slice(0, 20),
    };
    const result = await send(msg);
    window.postMessage(
      {
        __yhdx: 'lyrics', videoId: msg.videoId, cues: result?.cues ?? null,
        id: result?.id ?? null, source: result?.source ?? null, matched: result?.matched ?? null,
      },
      location.origin
    );
  }

  // Per-video subtitle choices ("out of sync" marks, timing nudge, off), kept on this PC only.
  const VIDEO_ID = /^[\w-]{6,20}$/;
  const prefsKey = (id) => `prefs:${id}`;

  function cleanPrefs(p) {
    const out = {};
    if (p?.off === true) out.off = true;
    if (p?.rejectYoutube === true) out.rejectYoutube = true;
    const rejected = (Array.isArray(p?.rejectedLyrics) ? p.rejectedLyrics : []).map(String).slice(0, 20);
    if (rejected.length) out.rejectedLyrics = rejected;
    const offset = Math.max(-30, Math.min(30, Number(p?.offset) || 0));
    if (offset) out.offset = offset;
    // TIDAL audio: 'youtube' = keep YouTube's sound for this video; offset = TIDAL earlier (-) / later (+);
    // rejectedTracks = TIDAL tracks you said are not the same recording.
    if (p?.audio === 'youtube' || p?.audio === 'tidal') out.audio = p.audio; // 'tidal': TIDAL's nearest version anyway
    const audioOffset = Math.max(-600, Math.min(600, Math.round((Number(p?.audioOffset) || 0) * 100) / 100));
    if (audioOffset) out.audioOffset = audioOffset;
    // From the published sync file: TIDAL's measured speed vs the video's, and which measurement was applied.
    const audioScale = Math.round((Number(p?.audioScale) || 1) * 1e6) / 1e6;
    if (audioScale !== 1 && audioScale > 0.9 && audioScale < 1.1) out.audioScale = audioScale;
    if (typeof p?.syncStamp === 'string' && p.syncStamp) out.syncStamp = p.syncStamp.slice(0, 80);
    // The TIDAL song you chose yourself (in your TIDAL tab) for this video.
    const t = p?.pickedTrack;
    if (t && /^\d{1,15}$/.test(String(t.id))) {
      out.pickedTrack = { id: String(t.id), title: String(t.title || '').slice(0, 200), artist: String(t.artist || '').slice(0, 200),
                          seconds: Math.max(0, Math.round(Number(t.seconds) || 0)) };
    }
    const rejectedTracks = (Array.isArray(p?.rejectedTracks) ? p.rejectedTracks : []).map(String).filter((x) => /^\d{1,15}$/.test(x)).slice(0, 20);
    if (rejectedTracks.length) out.rejectedTracks = rejectedTracks;
    return out;
  }

  // TIDAL audio: find the same recording (service worker), and pass the player's clock / commands to it.
  async function tidalMatch(req) {
    const msg = {
      type: 'tidal-match',
      videoId: String(req.videoId || ''),
      title: String(req.title || '').slice(0, 300),
      author: String(req.author || '').slice(0, 200),
      duration: Number(req.duration) || 0,
      exclude: (Array.isArray(req.exclude) ? req.exclude : []).map(String).slice(0, 20),
    };
    const result = await send(msg);
    const n = result?.nearest;
    const nearest = n && /^\d{1,15}$/.test(String(n.id)) ? { id: String(n.id), title: String(n.title || ''), version: n.version ? String(n.version) : null,
      artists: (Array.isArray(n.artists) ? n.artists : []).map(String).slice(0, 5), seconds: Number(n.seconds) || 0 } : null;
    window.postMessage({ __yhdx: 'tidal-match', videoId: msg.videoId, track: result?.track ?? null,
      reason: result?.reason ?? null, signedOut: !!result?.signedOut, preview: !!result?.preview,
      via: result?.via === 'web' ? 'web' : null, nearest, keepYoutube: !!result?.keepYoutube, sync: syncOf(result?.sync) }, location.origin);
  }

  // The sync file's measurement for this video (offset, speed), checked again here before the page gets it.
  function syncOf(s) {
    const offset = Number(s?.offset), scale = Number(s?.scale);
    if (!s || !Number.isFinite(offset) || Math.abs(offset) > 600 || !(scale > 0.9 && scale < 1.1)) return null;
    return { offset, scale, stamp: String(s.stamp || '').slice(0, 80) };
  }

  const AUDIO_CMDS = new Set(['load', 'clock', 'stop']);
  function tidalAudio(req) {
    if (!AUDIO_CMDS.has(req.cmd)) return;
    const msg = { type: 'tidal-audio', cmd: req.cmd };
    if (req.trackId != null) msg.trackId = String(req.trackId).replace(/\D/g, '').slice(0, 15);
    for (const k of ['at', 'videoTime', 'rate', 'offset', 'scale', 'volume', 'sentAt']) if (req[k] != null) msg[k] = Number(req[k]) || 0;
    if (req.playing != null) msg.playing = !!req.playing;
    if (req.fullscreen != null) msg.fullscreen = !!req.fullscreen;
    if (req.both != null) msg.both = !!req.both;
    if (req.via === 'web') msg.via = 'web';
    if (req.cmd === 'load' && req.title) msg.title = String(req.title).slice(0, 200);
    send(msg);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'tidal-sync') {
      window.postMessage({ __yhdx: 'tidal-sync', cmd: String(msg.cmd || ''), delta: Number(msg.delta) || 0, on: !!msg.on }, location.origin);
      return false;
    }
    if (msg?.type !== 'tidal-audio-status') return false;
    window.postMessage({ __yhdx: 'tidal-audio-status', status: String(msg.status || ''), trackId: msg.trackId ?? null,
      quality: msg.quality ?? null, bitDepth: msg.bitDepth ?? null, sampleRate: msg.sampleRate ?? null,
      message: msg.message ?? null }, location.origin);
    return false;
  });

  async function sendPrefs(videoId) {
    if (!VIDEO_ID.test(String(videoId))) return;
    let prefs = {};
    try { prefs = (await chrome.storage.local.get(prefsKey(videoId)))[prefsKey(videoId)] ?? {}; } catch { if (!alive()) stale(); }
    window.postMessage({ __yhdx: 'prefs', videoId, prefs }, location.origin);
  }

  async function savePrefs(videoId, prefs) {
    if (!VIDEO_ID.test(String(videoId))) return;
    const clean = cleanPrefs(prefs);
    try {
      if (Object.keys(clean).length) await chrome.storage.local.set({ [prefsKey(videoId)]: clean });
      else await chrome.storage.local.remove(prefsKey(videoId));
    } catch { if (!alive()) stale(); }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (typeof e.data.__yhdx === 'string' && !alive()) { stale(); return; } // cut off: nothing below can work
    if (e.data.__yhdx === 'ready') push();
    else if (e.data.__yhdx === 'lyrics-request') lyrics(e.data);
    else if (e.data.__yhdx === 'prefs-request') sendPrefs(e.data.videoId);
    else if (e.data.__yhdx === 'prefs-save') savePrefs(e.data.videoId, e.data.prefs);
    else if (e.data.__yhdx === 'tidal-match-request') tidalMatch(e.data);
    else if (e.data.__yhdx === 'tidal-audio') tidalAudio(e.data);
    else if (e.data.__yhdx === 'tidal-focus') send({ type: 'tidal-focus' });
    else if (e.data.__yhdx === 'tidal-sync-open') send({ type: 'tidal-sync-open' });
    else if (e.data.__yhdx === 'error') reportError(e.data.message, e.data.stack, 'player script'); // from the Player's script on the page
    else if (e.data.__yhdx === 'tidal-pick-request') {
      send({ type: 'tidal-pick', title: String(e.data.title || '').slice(0, 300) }).then((now) => {
        const ok = now && /^\d{1,15}$/.test(String(now.id));
        window.postMessage({ __yhdx: 'tidal-pick', track: ok ? { id: String(now.id), title: String(now.title || ''), artist: String(now.artist || ''),
          seconds: Number(now.seconds) || 0, at: Number(now.at) || 0, playing: !!now.playing, sentAt: Number(now.sentAt) || 0 } : null }, location.origin);
      });
    }
    else if (e.data.__yhdx === 'tidal-sync-state') {
      const d = e.data;
      send({ type: 'tidal-sync-state', title: String(d.title || '').slice(0, 200), offset: Number(d.offset) || 0, both: !!d.both,
             status: String(d.status || ''), closed: !!d.closed });
    }
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') push(); });
  push();
})();
