// The small "Sync TIDAL" window: drag it anywhere (another monitor); ← → move TIDAL's sound 0.1 s (Shift: 1 s),
// B hears both sounds at once, Enter keeps the shift, Esc puts back the one you had. It talks to the video's tab.
(() => {
  'use strict';
  const tabId = Number(new URLSearchParams(location.search).get('tab'));
  const $ = (id) => document.getElementById(id);
  const send = (cmd, extra = {}) => chrome.runtime.sendMessage({ type: 'tidal-sync', tabId, cmd, ...extra }).catch(() => {});
  let closing = false;

  function show(s) {
    $('song').textContent = s.title || '…';
    const o = Number(s.offset) || 0;
    $('offset').textContent = `${o > 0 ? '+' : o < 0 ? '−' : ''}${Math.abs(o).toFixed(1)} s`;
    $('hint').textContent = o > 0 ? 'TIDAL plays sooner' : o < 0 ? 'TIDAL plays later' : 'as found';
    $('both').checked = !!s.both;
    document.body.classList.toggle('off', s.status !== 'on' && s.status !== 'gap');
    if (s.closed && !closing) { closing = true; window.close(); }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'tidal-sync-state' && sender.tab?.id === tabId) show(msg);
    return false;
  });

  const nudge = (d) => send('nudge', { delta: d });
  for (const b of document.querySelectorAll('[data-d]')) b.addEventListener('click', () => nudge(Number(b.dataset.d)));
  $('both').addEventListener('change', (e) => send('both', { on: e.target.checked }));
  $('done').addEventListener('click', () => { closing = true; send('done').then(() => window.close()); });
  $('cancel').addEventListener('click', () => { closing = true; send('cancel').then(() => window.close()); });
  $('youtube').addEventListener('click', () => { closing = true; send('youtube').then(() => window.close()); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') nudge(e.shiftKey ? 1 : 0.1);
    else if (e.key === 'ArrowRight') nudge(e.shiftKey ? -1 : -0.1);
    else if (e.key === 'b' || e.key === 'B') { $('both').checked = !$('both').checked; send('both', { on: $('both').checked }); }
    else if (e.key === 'Enter') $('done').click();
    else if (e.key === 'Escape') $('cancel').click();
    else return;
    e.preventDefault();
  });

  // Where you put it is where it opens next time.
  const saveBounds = () => chrome.storage.local.set({ syncWindowBounds: { left: screenX, top: screenY, width: outerWidth, height: outerHeight } }).catch(() => {});
  setInterval(saveBounds, 2000);
  // Closing the window with its × keeps the shift too.
  window.addEventListener('pagehide', () => { saveBounds(); if (!closing) send('done'); });
  send('hello');
})();
