// Isolated world: reads settings from chrome.storage and hands them to the MAIN-world player script.
(() => {
  'use strict';

  async function push() {
    const settings = await chrome.storage.sync.get(YHDX_DEFAULTS);
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
    let result;
    try { result = await chrome.runtime.sendMessage(msg); } catch { result = null; }
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
    if (p?.audio === 'youtube') out.audio = 'youtube';
    const audioOffset = Math.max(-10, Math.min(10, Math.round((Number(p?.audioOffset) || 0) * 100) / 100));
    if (audioOffset) out.audioOffset = audioOffset;
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
    let result;
    try { result = await chrome.runtime.sendMessage(msg); } catch { result = null; }
    window.postMessage({ __yhdx: 'tidal-match', videoId: msg.videoId, track: result?.track ?? null,
      reason: result?.reason ?? null, signedOut: !!result?.signedOut }, location.origin);
  }

  const AUDIO_CMDS = new Set(['load', 'clock', 'stop']);
  function tidalAudio(req) {
    if (!AUDIO_CMDS.has(req.cmd)) return;
    const msg = { type: 'tidal-audio', cmd: req.cmd };
    if (req.trackId != null) msg.trackId = String(req.trackId).replace(/\D/g, '').slice(0, 15);
    for (const k of ['at', 'videoTime', 'rate', 'offset', 'volume', 'sentAt']) if (req[k] != null) msg[k] = Number(req[k]) || 0;
    if (req.playing != null) msg.playing = !!req.playing;
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'tidal-audio-status') return false;
    window.postMessage({ __yhdx: 'tidal-audio-status', status: String(msg.status || ''), trackId: msg.trackId ?? null,
      quality: msg.quality ?? null, bitDepth: msg.bitDepth ?? null, sampleRate: msg.sampleRate ?? null,
      message: msg.message ?? null }, location.origin);
    return false;
  });

  async function sendPrefs(videoId) {
    if (!VIDEO_ID.test(String(videoId))) return;
    const prefs = (await chrome.storage.local.get(prefsKey(videoId)))[prefsKey(videoId)] ?? {};
    window.postMessage({ __yhdx: 'prefs', videoId, prefs }, location.origin);
  }

  async function savePrefs(videoId, prefs) {
    if (!VIDEO_ID.test(String(videoId))) return;
    const clean = cleanPrefs(prefs);
    if (Object.keys(clean).length) await chrome.storage.local.set({ [prefsKey(videoId)]: clean });
    else await chrome.storage.local.remove(prefsKey(videoId));
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__yhdx === 'ready') push();
    else if (e.data.__yhdx === 'lyrics-request') lyrics(e.data);
    else if (e.data.__yhdx === 'prefs-request') sendPrefs(e.data.videoId);
    else if (e.data.__yhdx === 'prefs-save') savePrefs(e.data.videoId, e.data.prefs);
    else if (e.data.__yhdx === 'tidal-match-request') tidalMatch(e.data);
    else if (e.data.__yhdx === 'tidal-audio') tidalAudio(e.data);
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') push(); });
  push();
})();
