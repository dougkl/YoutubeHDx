// Error log: an error in one of the Player's pages (settings, Sync window, TIDAL player) is sent to the service
// worker, which keeps the errors list (settings page) and the file YoutubeHDx-Player-errors.txt in the NAS folder.
(() => {
  'use strict';
  const where = document.documentElement.dataset.yhdxWhere || location.pathname.replace(/^\/|\.html$/g, '') || 'page';
  const send = (message, stack) => {
    try {
      chrome.runtime.sendMessage({ type: 'yhdx-error', where, message: String(message || '').slice(0, 300), stack: String(stack || '').slice(0, 800) }).catch(() => {});
    } catch { /* cut off: nowhere to report to */ }
  };
  addEventListener('error', (e) => send(e.message || e.error?.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`));
  addEventListener('unhandledrejection', (e) => send(`unhandled: ${e.reason?.message || e.reason}`, e.reason?.stack));
})();
