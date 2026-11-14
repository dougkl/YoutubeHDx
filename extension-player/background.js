// Player extension service worker: toolbar button opens settings; looks up lyrics for videos without captions.
importScripts('lyrics.js');

const DAY = 24 * 60 * 60 * 1000;
const TTL = { found: 30 * DAY, notFound: 7 * DAY, retry: 60 * 60 * 1000 };

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function cachedLyrics(videoId) {
  const key = `lyrics:${videoId}`;
  const hit = (await chrome.storage.local.get(key))[key];
  return hit && Date.now() - hit.at < hit.ttl ? hit.result : undefined;
}

async function rememberLyrics(videoId, result) {
  const ttl = result.cues ? TTL.found : result.retryable ? TTL.retry : TTL.notFound;
  await chrome.storage.local.set({ [`lyrics:${videoId}`]: { at: Date.now(), ttl, result } });
}

async function lookupLyrics(msg) {
  if (!/^[\w-]{6,20}$/.test(String(msg.videoId || ''))) return { cues: null, reason: 'bad video id' };
  // "Try other subtitles" passes the rejected ones; those lookups skip the cache (it holds the rejected set).
  const exclude = (Array.isArray(msg.exclude) ? msg.exclude : []).map(String).slice(0, 20);
  if (!exclude.length) {
    const cached = await cachedLyrics(msg.videoId);
    if (cached !== undefined) return cached;
  }

  const { openSubtitlesKey } = await chrome.storage.local.get({ openSubtitlesKey: '' });
  const result = await yhdxFindLyrics(
    { title: msg.title, author: msg.author, duration: Number(msg.duration) },
    { fetchFn: (url, init) => fetch(url, init), openSubtitlesKey: String(openSubtitlesKey || '').trim(), exclude },
  );
  if (!exclude.length) await rememberLyrics(msg.videoId, result);
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'lyrics') return false;
  lookupLyrics(msg).then(sendResponse, (e) => sendResponse({ cues: null, reason: String(e?.message || e), retryable: true }));
  return true; // async response
});

// ---------------------------------------------------------------- TIDAL audio for music videos
// Sign-in (official OAuth with PKCE, in a Chrome sign-in window), finding the same recording for a video, and
// relaying the YouTube tab's clock to the offscreen page that plays TIDAL's audio. See tidal.js / offscreen.js.
importScripts('tidal.js');

const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const TIDAL_SCOPES = 'search.read playback user.read';
// A song that TIDAL only plays as a preview is looked at again after 3 days (access can change per song).
const TIDAL_MATCH_TTL = { found: 30 * DAY, notFound: 7 * DAY, preview: 3 * DAY };
let tidalAudioTab = null; // the tab whose video TIDAL is playing for
// Chrome stops this service worker when it's idle (e.g. a long pause), which would forget the tab: keep it in session storage.
const audioTabStore = chrome.storage.session;
async function audioTab() {
  if (tidalAudioTab == null && audioTabStore) tidalAudioTab = (await audioTabStore.get({ tidalAudioTab: null }).catch(() => ({}))).tidalAudioTab ?? null;
  return tidalAudioTab;
}
function setAudioTab(tabId) {
  tidalAudioTab = tabId;
  audioTabStore?.set({ tidalAudioTab: tabId }).catch(() => {});
}

/** Client ID: from the install pack (tidal-config.json, made by build-pack from your downloader settings) or the options page. */
async function tidalClientId() {
  const { tidalClientId: saved } = await chrome.storage.local.get({ tidalClientId: '' });
  if (saved) return saved;
  try {
    const r = await fetch(chrome.runtime.getURL('tidal-config.json'));
    if (r.ok) return String((await r.json()).clientId || '');
  } catch { /* not in the pack */ }
  return '';
}

async function tidalExchange(form) {
  const body = new URLSearchParams({ ...form, client_id: await tidalClientId() });
  const r = await fetch(TIDAL_TOKEN_URL, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`TIDAL sign-in failed (${r.status}) ${j.error_description || j.error || ''}`.trim());
  return { access: j.access_token, refresh: j.refresh_token || form.refresh_token || '', expires: Date.now() + (Number(j.expires_in) || 3600) * 1000, userId: j.user_id ? String(j.user_id) : null };
}

async function tidalSignIn() {
  const clientId = await tidalClientId();
  if (!clientId) throw new Error('Enter your TIDAL Client ID first');
  const redirectUri = chrome.identity.getRedirectURL('tidal');
  const pkce = await yhdxPkce();
  const back = await chrome.identity.launchWebAuthFlow({ url: yhdxTidalAuthorizeUrl(clientId, redirectUri, pkce, TIDAL_SCOPES), interactive: true });
  const q = new URL(back).searchParams;
  if (q.get('state') !== pkce.state) throw new Error('TIDAL sign-in answer did not match; try again');
  if (!q.get('code')) throw new Error(`TIDAL sign-in was not completed (${q.get('error') || 'no code'})`);
  const auth = await tidalExchange({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri, code_verifier: pkce.verifier });
  await chrome.storage.local.set({ tidalAuth: auth });
  return { signedIn: true };
}

async function tidalToken() {
  const { tidalAuth } = await chrome.storage.local.get({ tidalAuth: null });
  if (!tidalAuth?.access) return null;
  if (tidalAuth.expires > Date.now() + 120000) return tidalAuth;
  if (!tidalAuth.refresh) return null;
  const fresh = await tidalExchange({ grant_type: 'refresh_token', refresh_token: tidalAuth.refresh });
  await chrome.storage.local.set({ tidalAuth: fresh });
  return fresh;
}

// Only the extension's own pages (settings), not the YouTube content scripts.
const isExtensionPage = (sender) => String(sender?.url || '').startsWith(chrome.runtime.getURL(''));

// ---------------------------------------------------------------- TIDAL log (settings page: what happened per song)
const TIDAL_LOG_MAX = 40;
const trackLabel = (t) => (t ? `${t.artists?.[0] ?? ''} – ${t.title}${t.version ? ` (${t.version})` : ''} [${t.id}]` : '');
const trackTitles = new Map(); // track id -> video title, so the player's answers can say which song

// One write at a time: two entries close together would otherwise each read the old log and one would be lost.
let tidalLogQueue = Promise.resolve();
function tidalLog(entry) {
  const at = Date.now();
  tidalLogQueue = tidalLogQueue.then(async () => {
    try {
      const { tidalLog: log = [] } = await chrome.storage.local.get({ tidalLog: [] });
      log.unshift({ at, ...entry });
      await chrome.storage.local.set({ tidalLog: log.slice(0, TIDAL_LOG_MAX) });
    } catch { /* the log is only a help */ }
  });
  return tidalLogQueue;
}

function logMatch(msg, result, remembered) {
  const outcome = result.track ? (result.via === 'web' ? 'found, playing in your TIDAL web player tab' : 'found, playing TIDAL')
    : result.preview ? 'TIDAL gives only a 30-second preview'
    : result.signedOut ? 'not signed in to TIDAL' : 'not used';
  if (result.track) trackTitles.set(String(result.track.id), String(msg.title || ''));
  tidalLog({ video: String(msg.title || msg.videoId || ''), videoId: String(msg.videoId || ''), step: 'match', outcome,
    track: trackLabel(result.track || result.previewTrack),
    detail: [remembered ? '(remembered)' : '', result.track ? '' : result.reason, result.lengths].filter(Boolean).join(' · ') });
}

function logPlayer(msg) {
  if (!['playing', 'preview', 'error', 'revoked', 'need-click', 'changed'].includes(msg.status)) return;
  tidalLog({ video: trackTitles.get(String(msg.trackId)) || '', step: 'player', outcome: String(msg.status),
    track: msg.trackId ? `[${msg.trackId}]` : '', detail: [msg.quality, msg.message].filter(Boolean).join(' ') });
}

async function tidalMatch(msg) {
  const result = await tidalMatchInner(msg);
  logMatch(msg, result, result.remembered);
  delete result.remembered;
  return result;
}

async function tidalMatchInner(msg) {
  if (!/^[\w-]{6,20}$/.test(String(msg.videoId || ''))) return { track: null, reason: 'bad video id' };
  const exclude = (Array.isArray(msg.exclude) ? msg.exclude : []).map(String).slice(0, 20);
  const key = `tidal:${msg.videoId}`;
  const hit = (await chrome.storage.local.get(key))[key];
  if (hit && Date.now() - hit.at < hit.ttl && !exclude.length) {
    const r = { ...hit.result, remembered: true };
    // remembered from before 1.10 as "preview only": your TIDAL tab plays it in full now
    if (!r.track && r.preview && r.previewTrack) Object.assign(r, { track: r.previewTrack, via: 'web' });
    return r;
  }
  const auth = await tidalToken();
  if (!auth) return { track: null, reason: 'not signed in to TIDAL', signedOut: true };
  const { tidalCountry } = await chrome.storage.local.get({ tidalCountry: 'US' });
  const result = await yhdxTidalFindPlayable({ title: msg.title, author: msg.author, duration: Number(msg.duration) },
    { fetchFn: (url, init) => fetch(url, init), token: auth.access, country: tidalCountry, exclude });
  // TIDAL gives this app only a preview, but your own TIDAL web player plays the full song: use that.
  if (result.preview && result.previewTrack) Object.assign(result, { track: result.previewTrack, via: 'web' });
  const ttl = result.track ? TIDAL_MATCH_TTL.found : result.preview ? TIDAL_MATCH_TTL.preview : TIDAL_MATCH_TTL.notFound;
  if (!exclude.length) await chrome.storage.local.set({ [key]: { at: Date.now(), ttl, result } });
  return result;
}

let offscreenReady = null; // resolves when the offscreen page has loaded TIDAL's player and listens for commands

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) { await offscreenReady?.promise; return; }
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  offscreenReady = { promise, resolve };
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Plays the TIDAL version of the song in step with the YouTube music video' });
  } catch (e) {
    if (!String(e?.message || e).includes('single offscreen')) throw e;
  }
  // Commands sent before the page's script runs would be lost: wait for its "ready" (at most 10 s).
  await Promise.race([promise, new Promise((r) => setTimeout(r, 10000))]);
}

let tidalReopening = null;

// ---------------------------------------------------------------- your TIDAL web-player tab (full songs)
const TIDAL_WEB_URL = 'https://tidal.com';
let webLoad = null; // the last load sent to the web tab, sent again if that tab reloads

async function sessionGet(key) {
  try { return (await chrome.storage.session.get({ [key]: null }))[key]; } catch { return null; }
}
const sessionSet = (obj) => chrome.storage.session?.set(obj).catch(() => {});

async function webTab() {
  const id = await sessionGet('tidalWebTab');
  if (id == null) return null;
  try { await chrome.tabs.get(id); return id; } catch { return null; }
}

// The TIDAL tab to play in: yours if one is open (tidal.com), else a new pinned one in the background.
async function ensureWebTab(trackId) {
  const known = await webTab();
  if (known != null) return { id: known, fresh: false };
  const open = (await chrome.tabs.query({ url: ['https://tidal.com/*', 'https://listen.tidal.com/*'] }).catch(() => []))[0];
  if (open) { await sessionSet({ tidalWebTab: open.id }); return { id: open.id, fresh: false }; }
  const tab = await chrome.tabs.create({ url: `${TIDAL_WEB_URL}/track/${trackId}`, active: false, pinned: true });
  await sessionSet({ tidalWebTab: tab.id });
  return { id: tab.id, fresh: true };
}

// Chrome doesn't start sound in a background tab it has never shown (it waits until you look at it); a tab that has
// played once can go on loading songs in the background. So the TIDAL tab stays open between songs (paused: TIDAL never
// goes on to other songs by itself), and a new one is shown for a moment — then the video's tab is back in front.
const PEEK_MS = 1200;
const webPlayed = new Set(); // TIDAL tabs that have played since their page loaded
const ytFullscreen = new Map(); // video tab -> full screen (from its clock)
let peeking = null;

async function peekWebTab(webId, ytId) {
  if (peeking || webPlayed.has(webId)) return false;
  const web = await chrome.tabs.get(webId).catch(() => null);
  if (!web || web.active) return false;
  const win = await chrome.windows?.get(web.windowId).catch(() => null);
  if (win?.state === 'minimized') return false;
  const yt = ytId != null ? await chrome.tabs.get(ytId).catch(() => null) : null;
  const sameWindow = yt?.windowId === web.windowId;
  const back = sameWindow ? yt.id : (await chrome.tabs.query({ active: true, windowId: web.windowId }).catch(() => []))[0]?.id;
  // Switching tabs takes a full-screen video out of full screen: put it back right after (YouTube's own button).
  const refullscreen = sameWindow && yt.active && ytFullscreen.get(yt.id) === true;
  peeking = (async () => {
    await chrome.tabs.update(webId, { active: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, PEEK_MS));
    if (back != null) await chrome.tabs.update(back, { active: true }).catch(() => {});
    if (refullscreen) {
      await new Promise((r) => setTimeout(r, 300));
      await evalAsUser(yt.id, `(() => { if (document.fullscreenElement) return 'already';
        const b = document.querySelector('#movie_player .ytp-fullscreen-button'); if (!b) return 'none'; b.click(); return 'pressed'; })()`);
    }
  })();
  await peeking;
  peeking = null;
  return true;
}

async function tidalWebAudio(msg, tabId) {
  if (msg.cmd === 'load') {
    const { id, fresh } = await ensureWebTab(msg.trackId);
    webLoad = { ...msg, target: 'tidal-web' };
    // A new tab gets it with its "hello". A TIDAL tab open since before the Player was updated has no live copy of the
    // Player's script (Chrome doesn't add it to open tabs): reload it, and it says hello.
    const unheard = await chrome.tabs.sendMessage(id, webLoad).then(() => false,
      (e) => /Receiving end does not exist|Could not establish connection/i.test(String(e?.message || e)));
    // (Also a tab Chrome restored after a restart but hasn't loaded yet.) One still loading says hello by itself.
    const tab = unheard && !fresh ? await chrome.tabs.get(id).catch(() => null) : null;
    if (tab && (tab.status !== 'loading' || tab.discarded)) chrome.tabs.reload(id).catch(() => {});
    return;
  }
  const id = await webTab();
  if (id == null) {
    if (msg.cmd === 'clock') chrome.tabs.sendMessage(tabId, { type: 'tidal-audio-status', status: 'error', message: 'the TIDAL tab was closed' }).catch(() => {});
    return;
  }
  await chrome.tabs.sendMessage(id, { ...msg, target: 'tidal-web' }).catch(() => {});
  if (msg.cmd === 'stop') { webLoad = null; setAudioTab(null); }
}

// Chrome keeps your TIDAL tab silent until you click in it. The Player does that one click for you: it runs TIDAL's
// own Play for this song as a user action, through Chrome's debugger API attached for a moment (Chrome shows a bar
// "started debugging this browser" while it is). Once is enough for as long as that tab stays open.
const AUTO_START_WAIT_MS = 5000;
const PEEK_AFTER_MS = 1000; // after the automatic Play, TIDAL normally sounds within this; if not, show its tab
const autoStart = { tried: new Set(), timer: null, waiting: null };

// Runs a script in a tab as if you had clicked (Chrome's debugger, attached for a moment). Returns its value or null.
async function evalAsUser(tabId, expression) {
  if (!chrome.debugger) return null;
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch {
    return null;
  }
  try {
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, userGesture: true, returnByValue: true });
    return r?.result?.value ?? null;
  } catch {
    return null;
  } finally {
    setTimeout(() => chrome.debugger.detach(target).catch(() => {}), 500);
  }
}

async function autoStartWebTab(tabId, trackId) {
  if (!/^\d{1,15}$/.test(String(trackId))) return false;
  // The song is usually already in TIDAL's player bar, paused (its first start was blocked): press the bar's Play.
  // Pressing the song's row again doesn't start an already-loaded song.
  const expression = `(() => {
    const bar = document.querySelector('[data-test="footer-player"]');
    const link = bar && bar.querySelector('[data-test="footer-track-title"] a[href*="/track/"]');
    const play = bar && bar.querySelector('[data-test="play"]');
    if (play && link && /\\/track\\/${trackId}(\\D|$)/.test(link.getAttribute('href') || '')) { play.click(); return 'footer'; }
    const row = document.querySelector('[data-test="tracklist-row"][data-track-id="${trackId}"]');
    const b = row && (row.querySelector('[data-test="play-button"]') || row);
    if (b) { b.click(); return 'row'; }
    return 'none';
  })()`;
  const v = await evalAsUser(tabId, expression);
  return v === 'row' || v === 'footer';
}

async function onWebHello(tabId) {
  webPlayed.delete(tabId); // a page (re)loaded: it hasn't played yet
  await sessionSet({ tidalWebTab: tabId });
  if (webLoad && (await sessionGet('tidalAudioVia')) === 'web') chrome.tabs.sendMessage(tabId, webLoad).catch(() => {});
}

async function tidalAudio(msg, tabId) {
  if (msg.cmd === 'clock') ytFullscreen.set(tabId, msg.fullscreen === true);
  if (msg.cmd === 'load') await sessionSet({ tidalAudioVia: msg.via === 'web' ? 'web' : 'sdk' });
  if ((await sessionGet('tidalAudioVia')) === 'web') {
    if (msg.cmd === 'load') {
      const previous = await audioTab();
      if (previous != null && previous !== tabId) chrome.tabs.sendMessage(previous, { type: 'tidal-audio-status', status: 'taken' }).catch(() => {});
      setAudioTab(tabId);
    } else if (tabId !== (await audioTab())) return;
    return tidalWebAudio(msg, tabId);
  }
  if (msg.cmd === 'load') {
    const previous = await audioTab();
    if (previous != null && previous !== tabId) chrome.tabs.sendMessage(previous, { type: 'tidal-audio-status', status: 'taken' }).catch(() => {});
    setAudioTab(tabId);
    await ensureOffscreen();
  } else if (tabId !== (await audioTab())) {
    return; // another tab's leftovers
  } else if (msg.cmd === 'clock' && msg.playing && !(await chrome.offscreen.hasDocument?.())) {
    // Chrome closes the TIDAL page ~30 s after its sound stops (a long pause): open it again where the video is.
    if (!tidalReopening) {
      tidalReopening = ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'tidal-audio', cmd: 'load', trackId: msg.trackId, at: msg.videoTime, target: 'offscreen', tabId }))
        .catch(() => {})
        .finally(() => { tidalReopening = null; });
    }
    await tidalReopening;
  }
  if (!(await chrome.offscreen.hasDocument?.())) return;
  await chrome.runtime.sendMessage({ ...msg, target: 'offscreen', tabId }).catch(() => {});
  if (msg.cmd === 'stop') setAudioTab(null);
}

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  if (tabId === (await audioTab())) tidalAudio({ cmd: 'stop' }, tabId);
  else if (tabId === (await sessionGet('tidalWebTab'))) {
    webPlayed.delete(tabId);
    await sessionSet({ tidalWebTab: null });
    const tab = await audioTab();
    if (tab != null && webLoad) chrome.tabs.sendMessage(tab, { type: 'tidal-audio-status', status: 'error', message: 'the TIDAL tab was closed' }).catch(() => {});
    webLoad = null;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'tidal-credentials':
      // Asked by the offscreen player (TIDAL SDK credentials provider).
      Promise.all([tidalToken(), tidalClientId()]).then(([auth, clientId]) => sendResponse(auth ? {
        clientId, token: auth.access, expires: auth.expires, userId: auth.userId ?? undefined,
        requestedScopes: TIDAL_SCOPES.split(' '), grantedScopes: TIDAL_SCOPES.split(' '),
      } : { clientId, requestedScopes: TIDAL_SCOPES.split(' ') }), () => sendResponse({}));
      return true;
    case 'tidal-signin':
      tidalSignIn().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    case 'tidal-signout':
      chrome.storage.local.remove('tidalAuth').then(() => sendResponse({ ok: true }));
      return true;
    case 'tidal-status':
      Promise.all([chrome.storage.local.get({ tidalAuth: null }), tidalClientId()]).then(([s, clientId]) =>
        sendResponse({ signedIn: !!s.tidalAuth?.refresh, clientId, redirectUri: chrome.identity.getRedirectURL('tidal') }));
      return true;
    case 'tidal-match':
      tidalMatch(msg).then(sendResponse, (e) => {
        tidalLog({ video: String(msg.title || ''), videoId: String(msg.videoId || ''), step: 'match', outcome: 'error', detail: String(e?.message || e) });
        sendResponse({ track: null, reason: String(e?.message || e), retryable: true, signedOut: e?.status === 401 });
      });
      return true;
    case 'tidal-log':
      if (!isExtensionPage(sender)) return false;
      chrome.storage.local.get({ tidalLog: [] }).then((r) => sendResponse(r.tidalLog));
      return true;
    case 'tidal-log-clear':
      if (!isExtensionPage(sender)) return false;
      chrome.storage.local.remove('tidalLog').then(() => sendResponse({ ok: true }));
      return true;
    case 'tidal-audio':
      if (sender.tab?.id != null) tidalAudio(msg, sender.tab.id);
      return false;
    case 'tidal-focus':
      // "click here" on the video: bring your TIDAL tab to the front so you can press Play there once.
      webTab().then(async (id) => {
        if (id == null) return;
        const tab = await chrome.tabs.update(id, { active: true }).catch(() => null);
        if (tab?.windowId != null) chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {});
      });
      return false;
    case 'tidal-web-hello':
      if (sender.tab?.id != null) onWebHello(sender.tab.id);
      return false;
    case 'tidal-web-status':
      // From your TIDAL tab: pass to the YouTube tab it plays for.
      audioTab().then(async (tab) => {
        const m = { type: 'tidal-audio-status', status: String(msg.status || ''), trackId: msg.trackId ?? null, quality: msg.quality ?? null, via: 'web' };
        const forward = () => { logPlayer(m); if (tab != null) chrome.tabs.sendMessage(tab, m).catch(() => {}); };
        if (m.status === 'need-click') {
          // Do the click for you first; only if TIDAL still isn't playing a few seconds later, ask you.
          const key = `${sender.tab?.id}:${m.trackId}`;
          const fromTidal = /^https:\/\/(listen\.)?tidal\.com\//.test(String(sender.url || sender.tab?.url || ''));
          if (sender.tab?.id != null && fromTidal && !autoStart.tried.has(key)) {
            autoStart.tried.add(key);
            const webId = sender.tab.id;
            const pressed = await autoStartWebTab(webId, m.trackId);
            if (pressed) tidalLog({ video: trackTitles.get(String(m.trackId)) || '', step: 'player', outcome: 'started TIDAL for you (no click needed)', track: `[${m.trackId}]` });
            if (pressed || !webPlayed.has(webId)) {
              clearTimeout(autoStart.timer);
              autoStart.waiting = key;
              autoStart.timer = setTimeout(forward, AUTO_START_WAIT_MS);
              // A TIDAL tab Chrome has never shown waits for you to look at it before any sound: show it for a moment.
              setTimeout(async () => {
                if (autoStart.waiting !== key) return;
                if (await peekWebTab(webId, tab)) tidalLog({ video: trackTitles.get(String(m.trackId)) || '', step: 'player', outcome: 'showed the new TIDAL tab for a moment (Chrome starts sound only in a tab it has shown)', track: `[${m.trackId}]` });
              }, PEEK_AFTER_MS);
              return;
            }
          }
          forward();
          return;
        }
        if (m.status === 'loaded' || m.status === 'playing') {
          clearTimeout(autoStart.timer);
          autoStart.waiting = null;
          if (sender.tab?.id != null) webPlayed.add(sender.tab.id);
        }
        forward();
      });
      return false;
    case 'tidal-offscreen-ready':
      offscreenReady?.resolve();
      return false;
    case 'tidal-audio-status':
      // From the offscreen player: pass to the tab it plays for.
      logPlayer(msg);
      if (msg.tabId != null) chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
      return false;
    default:
      return false;
  }
});
