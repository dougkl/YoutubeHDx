// Runs in your TIDAL web-player tab (tidal.com / listen.tidal.com). When a YouTube music video has the same
// recording on TIDAL, it plays that song here — TIDAL's own player, signed in as you, so full songs (plays count like
// any TIDAL play) — and keeps it in step with the video, which stays muted. Uses tidal.js (yhdxSyncStep).
(() => {
  'use strict';
  if (window.__yhdxRemote) return;
  window.__yhdxRemote = true;

  const TICK_MS = 150;
  // Crossfade with the video (which fades out / back in at the same time): no gap when the sound switches.
  const FADE_IN_MS = 1500;
  const FADE_OUT_MS = 700;
  const BOTH_LEVEL = 0.6; // TIDAL's level while you hear both (Sync window)
  let fading = null;

  // TIDAL remembers its volume from the media element, so while the Player fades it, your real volume is kept here:
  // if the page reloads in the middle of a fade, the next start puts it back.
  const VOL_KEY = 'yhdx-tidal-volume';
  const keepVolume = (v) => { try { localStorage.setItem(VOL_KEY, String(v)); } catch { /* private mode */ } };
  const forgetVolume = () => { try { localStorage.removeItem(VOL_KEY); } catch { /* ignore */ } };
  function restoreVolume() {
    let saved = null;
    try { saved = localStorage.getItem(VOL_KEY); } catch { return; }
    const v = Number(saved);
    if (saved == null || !(v > 0 && v <= 1)) return;
    const end = Date.now() + 15000;
    const t = setInterval(() => {
      const els = [...document.querySelectorAll('video, audio')];
      if (els.length) { for (const m of els) m.volume = v; forgetVolume(); clearInterval(t); } else if (Date.now() > end) clearInterval(t);
    }, 300);
  }
  restoreVolume();

  function fadeMedia(m, from, to, ms, done, keep) {
    clearInterval(fading?.timer);
    if (keep > 0) keepVolume(keep);
    const start = Date.now();
    const f = fading = { m, to, timer: null };
    m.volume = Math.max(0, Math.min(1, from));
    f.timer = setInterval(() => {
      const x = Math.min(1, (Date.now() - start) / ms);
      const g = to > from ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
      m.volume = Math.max(0, Math.min(1, to > from ? to * g : from * g));
      if (x < 1) return;
      clearInterval(f.timer);
      if (fading === f) fading = null;
      done?.();
      if (keep > 0 && m.volume === keep) forgetVolume();
    }, 30);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel, root = document) => root.querySelector(sel);
  let current = null; // { trackId, clock, loaded, waitingClick, reported }
  let loop = null;

  // TIDAL keeps two media elements (one per upcoming track); the one playing is ours. Once found it is kept: while
  // it loads a new position it looks like neither, and looking again then would lose it.
  function findPlaying() {
    return [...document.querySelectorAll('video, audio')].find((m) => !m.paused && m.currentSrc) || null;
  }
  function media() {
    const c = current;
    if (c?.el && c.el.isConnected && c.el.currentSrc) return c.el;
    const m = findPlaying();
    if (c && m) c.el = m;
    return m;
  }
  const footer = () => q('[data-test="footer-player"]');
  const playPauseButton = () => footer() && q('[data-test="play"], [data-test="pause"]', footer());
  const quality = () => (footer() && q('[data-test^="quality-badge-"]', footer()))?.getAttribute('data-test').slice('quality-badge-'.length) || null;
  const rowFor = (id) => q(`[data-test="tracklist-row"][data-track-id="${id}"]`);
  // The song TIDAL's player bar shows (its title links to /track/<id>); null if it can't tell.
  function tidalTrack() {
    const a = footer() && q('[data-test="footer-track-title"] a[href*="/track/"]', footer());
    const m = a && /\/track\/(\d+)/.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  }
  const isOurs = (c) => tidalTrack() === c.trackId;
  // You picked other songs in the TIDAL tab this many times: the Player then leaves TIDAL to you.
  const MAX_CHANGES = 2;

  // What this tab looks like right now, for the TIDAL log when TIDAL won't start: is the tab on screen, what TIDAL's
  // player bar shows, what its media elements are doing, and any message TIDAL shows on the page.
  function snapshot() {
    const bar = footer();
    const btn = !bar ? 'no player bar' : q('[data-test="play"]', bar) ? 'Play' : q('[data-test="pause"]', bar) ? 'Pause' : 'no button';
    const media = [...document.querySelectorAll('video, audio')].map((m) => `${m.id || m.tagName.toLowerCase()} ${m.paused ? 'paused' : 'playing'}` +
      ` ready${m.readyState} net${m.networkState}${m.error ? ` error${m.error.code}` : ''} vol${m.volume.toFixed(2)}${m.muted ? ' muted' : ''} at${m.currentTime.toFixed(1)}`).join(', ');
    const said = [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="dialog"], [data-test*="notification"], [data-test*="toast"], [data-test*="modal"], [data-test*="snackbar"]')]
      .map((e) => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean).join(' / ').slice(0, 240);
    return `tab ${document.visibilityState}${document.hasFocus() ? ' focused' : ''}, clicked-in ${!!navigator.userActivation?.hasBeenActive}; ` +
      `bar: ${btn}, song ${tidalTrack() ?? '?'}; media: ${media || 'none'}${said ? `; TIDAL says: ${said}` : ''}`;
  }

  // TIDAL's own message that it can't play the song here ("Sorry, this content is currently unavailable. (NPBI0)").
  function tidalSaysUnavailable() {
    for (const e of document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="dialog"], [data-test*="notification"], [data-test*="toast"], [data-test*="modal"], [data-test*="snackbar"]')) {
      const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
      if (/currently unavailable|not available (in your|for you)|unavailable in your|\(NPBI\d*\)/i.test(t)) return t.slice(0, 200);
    }
    return null;
  }

  // Our song can't be played on TIDAL: say so once and stop trying (the Player goes back to YouTube's sound).
  function giveUpIfUnavailable(c) {
    const said = isOurs(c) && tidalSaysUnavailable();
    if (!said) return false;
    report('unavailable', { detail: `TIDAL says: ${said}` });
    clearInterval(loop);
    loop = null;
    if (current === c) current = null;
    return true;
  }

  function report(status, extra = {}) {
    if (!current || !alive()) return;
    try {
      chrome.runtime.sendMessage({ type: 'tidal-web-status', status, trackId: current.trackId, ...extra }).catch(() => {});
    } catch { /* cut off */ }
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v || Date.now() > end) return v || null;
      await sleep(150);
    }
  }

  // Open the song's page inside TIDAL's app (no page reload: a reload would need your click again before sound).
  function openTrackPage(id) {
    if (rowFor(id)) return;
    history.pushState({}, '', `/track/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  function setPlaying(on, m = media()) {
    if (!m || m.paused !== on) return;
    const b = playPauseButton();
    if (b) b.click();
    else if (on) m.play().catch(() => {});
    else m.pause();
  }

  // Select our song in TIDAL and wait until it plays: TIDAL's player bar must show it, not just any sound.
  async function playOurs(c) {
    openTrackPage(c.trackId);
    const row = await waitFor(() => rowFor(c.trackId), 8000);
    if (current !== c) return false;
    if (!row) {
      // TIDAL's app didn't follow the in-page navigation: load the song's page.
      location.assign(`/track/${c.trackId}`);
      return false;
    }
    const playingAlready = row.getAttribute('data-test-is-playing') === 'true' && findPlaying() && isOurs(c);
    c.audible = !!playingAlready; // you're already hearing it (you chose it in this tab): no fade-in from silence
    if (!playingAlready) {
      c.el = null;
      (q('[data-test="play-button"]', row) || row).click();
    }
    const m = await waitFor(() => { const x = findPlaying(); return x && x.readyState >= 2 && isOurs(c) ? x : null; }, 6000);
    if (current !== c) return false;
    if (m) c.el = m;
    return !!m;
  }

  async function load(msg) {
    stop(false);
    const mine = current = { trackId: String(msg.trackId), at: Number(msg.at) || 0, clock: null, loaded: false,
      waitingClick: false, reported: false, switching: false, changes: 0 };
    const ok = await playOurs(mine);
    if (current !== mine) return;
    if (ok) {
      mine.loaded = true;
      report('loaded');
    } else if (giveUpIfUnavailable(mine)) {
      return;
    } else {
      // Chrome only lets a page play sound after a click in it (the Player tries that click itself).
      mine.waitingClick = true;
      report('need-click', { detail: snapshot() });
    }
    start();
  }

  // Back to our song (after a click in the TIDAL tab started something else).
  function reselect(c) {
    if (c.switching) return;
    c.switching = true;
    playOurs(c).then((ok) => {
      if (current !== c) return;
      c.switching = false;
      if (ok && !c.loaded) { c.loaded = true; c.waitingClick = false; report('loaded'); }
    });
  }

  function start() {
    clearInterval(loop);
    loop = setInterval(tick, TICK_MS);
  }

  function stop(pause = true) {
    clearInterval(loop);
    loop = null;
    const c = current;
    current = null;
    const m = c && (c.el || findPlaying());
    if (pause && m && !m.paused) {
      const vol = c.vol ?? m.volume;
      fadeMedia(m, m.volume, 0, FADE_OUT_MS, () => { setPlaying(false, m); m.volume = vol; }, vol);
    } else if (m && c.vol != null && fading?.m === m) {
      clearInterval(fading.timer);
      fading = null;
      m.volume = c.vol;
    }
  }

  // The Player was updated or reloaded: this copy is cut off and nothing keeps TIDAL in step with the video any more.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  function tick() {
    const c = current;
    if (!c) return;
    if (!alive()) { stop(); return; } // fade out and pause (the new copy takes over once the page asks again)
    if (c.switching) return;
    if (c.waitingClick) {
      if (giveUpIfUnavailable(c)) return;
      const playing = findPlaying();
      if (!playing) {
        // Sound is allowed now (a click in this tab), our song is in the player bar but paused: press the bar's Play.
        if (navigator.userActivation?.hasBeenActive && isOurs(c) && Date.now() - (c.pressedAt || 0) > 2000) {
          c.pressedAt = Date.now();
          playPauseButton()?.click();
        }
        return;
      }
      if (!isOurs(c)) { reselect(c); return; } // sound is allowed now, but it's another song: put ours on
      c.el = playing;
      c.waitingClick = false;
      c.loaded = true;
      report('loaded');
    }
    if (c.loaded && tidalTrack() && !isOurs(c)) {
      // Another song in the TIDAL tab (your click there?): back to ours; if you keep choosing others, they're yours.
      c.changes += 1;
      if (c.changes >= MAX_CHANGES) {
        report('changed');
        clearInterval(loop);
        loop = null;
        current = null;
        return;
      }
      reselect(c);
      return;
    }
    const m = media();
    if (!c.loaded || !c.clock || !m) return;
    const k = c.clock;
    const target = k.videoTime + (k.playing ? ((Date.now() - k.sentAt) / 1000) * k.rate : 0) + (k.offset || 0);
    // Never to the end of TIDAL's song: TIDAL would go on to another song by itself.
    const atEnd = Number.isFinite(m.duration) && m.duration > 1 && target >= m.duration - 0.3;
    if (!k.playing || target < 0 || atEnd) {
      // TIDAL's song has nothing here (the video's longer intro or ending): the video's own sound meanwhile.
      if (k.playing && c.reported) { c.reported = false; report('gap'); }
      setPlaying(false, m);
      return;
    }
    if (m.paused) {
      if (!m.seeking && Math.abs(m.currentTime - target) > 0.35) m.currentTime = Math.max(0, target);
      if (!c.reported && c.vol == null) { c.vol = m.volume || 1; keepVolume(c.vol); m.volume = 0; } // silent until the crossfade
      setPlaying(true, m);
      return;
    }
    if (!c.reported) {
      c.reported = true;
      if (c.vol == null) c.vol = m.volume || 1;
      if (!c.audible) fadeMedia(m, 0, c.vol, FADE_IN_MS, null, c.vol); // the video fades out at the same time
      report('playing', { quality: quality() });
    }
    // "Hear both" (the Sync window): TIDAL a bit quieter alongside the video's sound; back to your volume after.
    // (Only when it switches: your own volume changes in TIDAL stay yours.)
    if (!fading && c.vol != null && k.both !== !!c.both) {
      c.both = k.both;
      if (k.both) keepVolume(c.vol);
      m.volume = c.vol * (k.both ? BOTH_LEVEL : 1);
      if (!k.both) forgetVolume();
    }
    if (m.seeking) return;
    const step = yhdxSyncStep(m.currentTime, target, k.rate);
    if (step.seek != null) m.currentTime = step.seek;
    else if (Math.abs(m.playbackRate - step.rate) > 0.0005) m.playbackRate = step.rate;
  }

  // The song in TIDAL's player bar and where it is: for "Use the song in my TIDAL tab for this video".
  function nowPlaying() {
    const bar = footer();
    const id = tidalTrack();
    if (!bar || !id) return null;
    const m = findPlaying() || [...document.querySelectorAll('video, audio')].find((x) => x.currentSrc && x.readyState >= 1) || null;
    return {
      id,
      title: (q('[data-test="footer-track-title"]', bar)?.innerText || '').trim().slice(0, 200),
      artist: (q('a[href*="/artist/"]', bar)?.innerText || '').trim().slice(0, 200),
      seconds: m && Number.isFinite(m.duration) ? Math.round(m.duration) : 0,
      at: m ? m.currentTime : 0,
      playing: !!(m && !m.paused),
      sentAt: Date.now(),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'tidal-web') return false;
    if (msg.cmd === 'which') { sendResponse(nowPlaying()); return false; }
    if (msg.cmd === 'load') load(msg);
    else if (msg.cmd === 'clock' && current && String(msg.trackId) === current.trackId) {
      current.clock = { videoTime: Number(msg.videoTime) || 0, playing: !!msg.playing, rate: Number(msg.rate) || 1,
        offset: Number(msg.offset) || 0, both: !!msg.both, sentAt: Number(msg.sentAt) || Date.now() };
      tick(); // a hidden tab's timers can be slow: every clock is also a tick
    } else if (msg.cmd === 'stop') stop();
    else if (msg.cmd === 'diag' && current) report('diag', { detail: snapshot() });
    return false;
  });

  chrome.runtime.sendMessage({ type: 'tidal-web-hello' }).catch(() => {});
})();
