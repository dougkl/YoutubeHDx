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
    return out;
  }

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
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') push(); });
  push();
})();
