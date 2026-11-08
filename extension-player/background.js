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

async function tidalLog(entry) {
  try {
    const { tidalLog: log = [] } = await chrome.storage.local.get({ tidalLog: [] });
    log.unshift({ at: Date.now(), ...entry });
    await chrome.storage.local.set({ tidalLog: log.slice(0, TIDAL_LOG_MAX) });
  } catch { /* the log is only a help */ }
}

function logMatch(msg, result, remembered) {
  const outcome = result.track ? 'found, playing TIDAL' : result.preview ? 'TIDAL gives only a 30-second preview'
    : result.signedOut ? 'not signed in to TIDAL' : 'not used';
  if (result.track) trackTitles.set(String(result.track.id), String(msg.title || ''));
  tidalLog({ video: String(msg.title || msg.videoId || ''), videoId: String(msg.videoId || ''), step: 'match', outcome,
    track: trackLabel(result.track || result.previewTrack), detail: (remembered ? '(remembered) ' : '') + String(result.reason || '') });
}

function logPlayer(msg) {
  if (!['playing', 'preview', 'error', 'revoked'].includes(msg.status)) return;
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
  if (hit && Date.now() - hit.at < hit.ttl && !exclude.length) return { ...hit.result, remembered: true };
  const auth = await tidalToken();
  if (!auth) return { track: null, reason: 'not signed in to TIDAL', signedOut: true };
  const { tidalCountry } = await chrome.storage.local.get({ tidalCountry: 'US' });
  const result = await yhdxTidalFindPlayable({ title: msg.title, author: msg.author, duration: Number(msg.duration) },
    { fetchFn: (url, init) => fetch(url, init), token: auth.access, country: tidalCountry, exclude });
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

async function tidalAudio(msg, tabId) {
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

chrome.tabs?.onRemoved?.addListener(async (tabId) => { if (tabId === (await audioTab())) tidalAudio({ cmd: 'stop' }, tabId); });

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
