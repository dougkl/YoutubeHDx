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
const TIDAL_MATCH_TTL = { found: 30 * DAY, notFound: 7 * DAY };
let tidalAudioTab = null; // the tab whose video TIDAL is playing for

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

async function tidalMatch(msg) {
  if (!/^[\w-]{6,20}$/.test(String(msg.videoId || ''))) return { track: null, reason: 'bad video id' };
  const exclude = (Array.isArray(msg.exclude) ? msg.exclude : []).map(String).slice(0, 20);
  const key = `tidal:${msg.videoId}`;
  const hit = (await chrome.storage.local.get(key))[key];
  if (hit && Date.now() - hit.at < hit.ttl && !exclude.length) return hit.result;
  const auth = await tidalToken();
  if (!auth) return { track: null, reason: 'not signed in to TIDAL', signedOut: true };
  const { tidalCountry } = await chrome.storage.local.get({ tidalCountry: 'US' });
  const result = await yhdxTidalFind({ title: msg.title, author: msg.author, duration: Number(msg.duration) },
    { fetchFn: (url, init) => fetch(url, init), token: auth.access, country: tidalCountry, exclude });
  if (!exclude.length) await chrome.storage.local.set({ [key]: { at: Date.now(), ttl: result.track ? TIDAL_MATCH_TTL.found : TIDAL_MATCH_TTL.notFound, result } });
  return result;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Plays the TIDAL version of the song in step with the YouTube music video' });
  } catch (e) {
    if (!String(e?.message || e).includes('single offscreen')) throw e;
  }
}

async function tidalAudio(msg, tabId) {
  if (msg.cmd === 'load') {
    if (tidalAudioTab != null && tidalAudioTab !== tabId) chrome.tabs.sendMessage(tidalAudioTab, { type: 'tidal-audio-status', status: 'taken' }).catch(() => {});
    tidalAudioTab = tabId;
    await ensureOffscreen();
  } else if (tabId !== tidalAudioTab) {
    return; // another tab's leftovers
  }
  if (!(await chrome.offscreen.hasDocument?.())) return;
  await chrome.runtime.sendMessage({ ...msg, target: 'offscreen', tabId }).catch(() => {});
  if (msg.cmd === 'stop') tidalAudioTab = null;
}

chrome.tabs?.onRemoved?.addListener((tabId) => { if (tabId === tidalAudioTab) tidalAudio({ cmd: 'stop' }, tabId); });

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
      tidalMatch(msg).then(sendResponse, (e) => sendResponse({ track: null, reason: String(e?.message || e), retryable: true, signedOut: e?.status === 401 }));
      return true;
    case 'tidal-audio':
      if (sender.tab?.id != null) tidalAudio(msg, sender.tab.id);
      return false;
    case 'tidal-audio-status':
      // From the offscreen player: pass to the tab it plays for.
      if (msg.tabId != null) chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
      return false;
    default:
      return false;
  }
});
