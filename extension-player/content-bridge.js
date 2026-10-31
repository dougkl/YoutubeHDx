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

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__yhdx === 'ready') push();
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') push(); });
  push();
})();
