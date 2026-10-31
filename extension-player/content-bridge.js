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
    };
    let result;
    try { result = await chrome.runtime.sendMessage(msg); } catch { result = null; }
    window.postMessage(
      { __yhdx: 'lyrics', videoId: msg.videoId, cues: result?.cues ?? null, source: result?.source ?? null },
      location.origin
    );
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__yhdx === 'ready') push();
    else if (e.data.__yhdx === 'lyrics-request') lyrics(e.data);
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') push(); });
  push();
})();
