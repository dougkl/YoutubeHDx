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
importScripts('backup.js');

const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const TIDAL_SCOPES = 'search.read playback user.read';
// A song that TIDAL only plays as a preview is looked at again after 3 days (access can change per song).
const TIDAL_MATCH_TTL = { found: 30 * DAY, notFound: 7 * DAY, preview: 3 * DAY };
const TIDAL_MATCH_RULES = 4; // 2: radio edits / single versions count when the length matches; 3: + nearest version; 4: up to 20 s
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

// ---------------------------------------------------------------- error log (every part of the Player)
// Errors from the service worker, the YouTube page, the TIDAL tab and the Player's own pages: the newest 100 (the
// same error again within 10 minutes counts up instead of adding a line). Shown in the settings, and written as
// YoutubeHDx-Player-errors.txt in the NAS folder, so it can be read when something goes wrong.
const ERROR_LOG_MAX = 100;
let errorLogQueue = Promise.resolve();
function errorLog({ where = 'background', message = '', stack = '' } = {}) {
  const at = Date.now();
  const entry = { at, where: String(where).slice(0, 40), message: String(message).slice(0, 300), stack: String(stack).slice(0, 800) };
  if (!entry.message) return errorLogQueue;
  errorLogQueue = errorLogQueue.then(async () => {
    try {
      const { errorLog: log = [] } = await chrome.storage.local.get({ errorLog: [] });
      const same = log.find((e) => e.where === entry.where && e.message === entry.message && at - e.at < 10 * 60000);
      if (same) { same.count = (same.count || 1) + 1; same.at = at; } else log.unshift(entry);
      log.sort((a, b) => b.at - a.at);
      await chrome.storage.local.set({ errorLog: log.slice(0, ERROR_LOG_MAX) });
    } catch { /* nowhere to keep it */ }
  });
  return errorLogQueue;
}
globalThis.addEventListener?.('error', (e) => errorLog({ message: e.message || e.error?.message, stack: e.error?.stack || `${e.filename}:${e.lineno}` }));
globalThis.addEventListener?.('unhandledrejection', (e) => errorLog({ message: `unhandled: ${e.reason?.message || e.reason}`, stack: e.reason?.stack }));

function errorLogText(head, log) {
  const lines = (Array.isArray(log) ? log : []).map((e) => `${new Date(e.at).toLocaleString()} | ${e.where} | ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}${e.stack ? `\n    ${e.stack.split('\n').slice(0, 4).join('\n    ')}` : ''}`);
  return [head].concat(lines.length ? lines : ['(no errors)']).join('\n');
}

// ---------------------------------------------------------------- TIDAL log (settings page: what happened per song)
const TIDAL_LOG_MAX = 80;
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
  if (!['playing', 'preview', 'error', 'revoked', 'need-click', 'changed', 'diag', 'unavailable'].includes(msg.status)) return;
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
  // TIDAL tracks your TIDAL tab said it can't play: never again (another version of the song may play).
  const unplayable = Object.keys(await unplayableTracks());
  // Answers "not on TIDAL" from before the matching rules last changed are asked again; so are answers naming a
  // track that turned out unplayable.
  // The published sync file (measured ahead of time): its track, offset and speed; or "keep YouTube's sound".
  const syncDoc = await syncFile();
  const sync = yhdxSyncEntry(syncDoc, msg.videoId);
  if (sync?.status === 'keep-youtube' && !exclude.length) {
    return { track: null, keepYoutube: true, reason: `sync file: keep YouTube's sound (${sync.reason || 'checked'})` };
  }
  if (sync?.status === 'ok' && !exclude.includes(sync.tidal) && !unplayable.includes(sync.tidal)) {
    const auth = await tidalToken();
    if (!auth) return { track: null, reason: 'not signed in to TIDAL', signedOut: true };
    const { tidalCountry } = await chrome.storage.local.get({ tidalCountry: 'US' });
    const pres = await yhdxTidalPresentation(sync.tidal, { fetchFn: (url, init) => fetch(url, init), token: auth.access, country: tidalCountry });
    const name = String(syncDoc.videos[msg.videoId]?.tidalTitle || '');
    const cut = name.indexOf(' - ');
    const track = { id: sync.tidal, title: cut > 0 ? name.slice(cut + 3) : name, artists: cut > 0 ? [name.slice(0, cut)] : [], seconds: null };
    return { track, sync: { offset: sync.offset, scale: sync.scale, stamp: sync.stamp, ...(sync.segments ? { segments: sync.segments } : {}) }, query: 'sync file',
             ...(pres === 'PREVIEW' ? { via: 'web' } : {}) };
  }
  const stale = hit && ((!hit.result?.track && !hit.result?.preview && (hit.rules ?? 1) < TIDAL_MATCH_RULES)
    || unplayable.includes(String(hit.result?.track?.id)) || unplayable.includes(String(hit.result?.nearest?.id)));
  if (hit && !stale && Date.now() - hit.at < hit.ttl && !exclude.length) {
    const r = { ...hit.result, remembered: true };
    // remembered from before 1.10 as "preview only": your TIDAL tab plays it in full now
    if (!r.track && r.preview && r.previewTrack) Object.assign(r, { track: r.previewTrack, via: 'web' });
    return r;
  }
  const auth = await tidalToken();
  if (!auth) return { track: null, reason: 'not signed in to TIDAL', signedOut: true };
  const { tidalCountry } = await chrome.storage.local.get({ tidalCountry: 'US' });
  const result = await yhdxTidalFindPlayable({ title: msg.title, author: msg.author, duration: Number(msg.duration) },
    { fetchFn: (url, init) => fetch(url, init), token: auth.access, country: tidalCountry, exclude: [...new Set([...exclude, ...unplayable])].slice(0, 60) });
  // TIDAL gives this app only a preview, but your own TIDAL web player plays the full song: use that.
  if (result.preview && result.previewTrack) Object.assign(result, { track: result.previewTrack, via: 'web' });
  const ttl = result.track ? TIDAL_MATCH_TTL.found : result.preview ? TIDAL_MATCH_TTL.preview : TIDAL_MATCH_TTL.notFound;
  if (!exclude.length) await chrome.storage.local.set({ [key]: { at: Date.now(), ttl, result, rules: TIDAL_MATCH_RULES } });
  return result;
}

// The sync file from the GitHub repo (sync/tidal-sync.json), kept in storage; fetched again every 6 hours. If GitHub
// can't be reached, the last good copy stays.
const SYNC_FILE_REFRESH_MS = 6 * 60 * 60 * 1000;
let syncFileMemo = null;
async function syncFile({ force = false } = {}) {
  if (!syncFileMemo) syncFileMemo = (await chrome.storage.local.get({ tidalSyncFile: null })).tidalSyncFile;
  if (force && syncFileMemo) syncFileMemo = { ...syncFileMemo, at: 0 };
  if (syncFileMemo && Date.now() - syncFileMemo.at < SYNC_FILE_REFRESH_MS) return syncFileMemo.doc;
  try {
    const r = await fetch(YHDX_SYNC_FILE_URL, { cache: 'no-store' });
    if (r.ok) {
      const doc = await r.json();
      if (doc?.format === 1 && doc.videos && typeof doc.videos === 'object') {
        syncFileMemo = { at: Date.now(), doc };
        await chrome.storage.local.set({ tidalSyncFile: syncFileMemo });
      }
    }
  } catch { /* offline: keep the last good copy */ }
  // Not reached (or not a sync file): try again in 10 minutes, not with every song; the last good copy meanwhile.
  const retry = Date.now() - SYNC_FILE_REFRESH_MS + 10 * 60 * 1000;
  if (!syncFileMemo) syncFileMemo = { at: retry, doc: null };
  else if (Date.now() - syncFileMemo.at >= SYNC_FILE_REFRESH_MS) syncFileMemo.at = retry;
  return syncFileMemo?.doc ?? null;
}

// { trackId: when } of TIDAL tracks your TIDAL tab couldn't play ("currently unavailable"), kept 30 days.
const UNPLAYABLE_DAYS = 30;
async function unplayableTracks() {
  const { tidalUnplayable: u = {} } = await chrome.storage.local.get({ tidalUnplayable: {} });
  const fresh = Object.fromEntries(Object.entries(u).filter(([, at]) => Date.now() - at < UNPLAYABLE_DAYS * DAY));
  return fresh;
}
async function markUnplayable(trackId) {
  const u = await unplayableTracks();
  u[String(trackId)] = Date.now();
  await chrome.storage.local.set({ tidalUnplayable: u });
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

// ---------------------------------------------------------------- backup of your choices
// After every change (10 s later, once): to the NAS folder you chose in the settings, when Chrome still allows that
// folder (after a restart it may need your OK once, in the settings). Never through Chrome's downloads: with "Ask
// where to save each file" on, that was a Save As dialog after every change.
const BACKUP_DELAY_MS = 10000;
let backupTimer = null;

function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { backupTimer = null; runBackup(); }, BACKUP_DELAY_MS);
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'sync' || Object.keys(changes).some((k) => k.startsWith('prefs:'))) scheduleBackup();
  if (area === 'local' && ('tidalLog' in changes || 'errorLog' in changes)) scheduleLogFile();
});

// The TIDAL log as a text file in the same folder (YoutubeHDx-Player-log.txt), 5 s after new entries.
const LOG_FILE_DELAY_MS = 5000;
let logFileTimer = null;
function scheduleLogFile() {
  clearTimeout(logFileTimer);
  logFileTimer = setTimeout(() => { logFileTimer = null; writeLogFile(); }, LOG_FILE_DELAY_MS);
}
async function writeLogFile() {
  const [{ tidalLog: log = [], tidalAuth }, clientId, settings] = await Promise.all([
    chrome.storage.local.get({ tidalLog: [], tidalAuth: null }), tidalClientId().catch(() => null), chrome.storage.sync.get({ tidalAudio: true })]);
  const head = `YoutubeHDx Player ${chrome.runtime.getManifest?.().version ?? ''} · TIDAL audio ${settings.tidalAudio ? 'on' : 'OFF'} · `
    + `${tidalAuth?.refresh ? 'signed in to TIDAL' : 'NOT signed in to TIDAL'} · Client ID ${clientId ? 'set' : 'MISSING'} · written ${new Date().toLocaleString()}`;
  const dir = await yhdxGetBackupDir();
  const status = await yhdxWriteLogToFolder(dir, yhdxLogText(head, log));
  if (status === 'ok') {
    const { errorLog: errors = [] } = await chrome.storage.local.get({ errorLog: [] });
    await yhdxWriteFile(dir, 'YoutubeHDx-Player-errors.txt', errorLogText(head.replace(/ · Client ID.*· written/, ' · written'), errors)).catch(() => {});
  }
  await chrome.storage.local.set({ logFileStatus: { at: Date.now(), status } });
  return status;
}

async function runBackup() {
  const data = await yhdxBackupData();
  const status = { at: Date.now(), videos: Object.keys(data.videos).length,
                   nas: await yhdxBackupToFolder(await yhdxGetBackupDir(), JSON.stringify(data, null, 1)) };
  await chrome.storage.local.set({ backupStatus: status });
  return status;
}

// ---------------------------------------------------------------- ready check
// Is everything the Player needs ready? When Chrome starts and after an install/update (a light check: it opens and
// reloads nothing), and from the settings page ("Check now": it may open the TIDAL tab to test it). A problem shows
// as a red "!" on the Player's icon; the result goes to the TIDAL log (and so to the log file on the NAS).
// Each item: ok true (ready) / false (a problem, with how to fix it) / null (can't tell yet, with why).
const READY_STARTUP_DELAY_MS = 20000;

async function readyCheck({ thorough = false } = {}) {
  const items = [];
  const add = (id, label, ok, detail = '', fix = '') => items.push({ id, label, ok, detail, fix });
  const settings = await chrome.storage.sync.get({ tidalAudio: true });

  // The published sync file (videos synced for you)
  const sf = await syncFile({ force: thorough }).catch(() => null);
  add('sync-file', 'Sync file (videos synced for you)', sf ? true : null,
    sf ? `${Object.keys(sf.videos).length} videos, measured ${String(sf.updated || '').slice(0, 10)}` : 'not loaded yet',
    'It loads from GitHub (dougkl/YoutubeHDx, sync/tidal-sync.json): check the internet connection.');

  // TIDAL sign-in and search (finding the songs)
  const clientId = await tidalClientId().catch(() => '');
  add('tidal-client', 'TIDAL app (Client ID)', !!clientId, clientId ? 'set' : 'missing', 'Run Install-Latest-Player.cmd again (it fills in the Client ID).');
  let token = null;
  try { token = await tidalToken(); } catch (e) { token = null; }
  add('tidal-signin', 'Signed in to TIDAL', !!token?.access, token?.access ? 'yes' : 'no (or the sign-in expired)', 'Player settings → Sign in to TIDAL.');
  if (token?.access) {
    try {
      const { tidalCountry } = await chrome.storage.local.get({ tidalCountry: 'US' });
      const found = await yhdxTidalSearch('Queen Bohemian Rhapsody', { fetchFn: (u, i) => fetch(u, i), token: token.access, country: tidalCountry, max: 3 });
      add('tidal-search', 'TIDAL search (finding the songs)', found.length > 0, found.length ? `works (${found.length} results)` : 'no results', 'Try again in a minute; TIDAL may be having problems.');
    } catch (e) {
      add('tidal-search', 'TIDAL search (finding the songs)', false, String(e?.message || e).slice(0, 120), 'Try again in a minute; if it stays, sign in to TIDAL again.');
    }
  }
  if (!settings.tidalAudio) add('tidal-audio', 'TIDAL audio', null, 'turned off in the settings', 'Player settings → TIDAL audio.');

  // Your TIDAL tab (where the songs play)
  let webId = await webTab();
  if (webId == null) webId = (await chrome.tabs.query({ url: ['https://tidal.com/*', 'https://listen.tidal.com/*'] }).catch(() => []))[0]?.id ?? null;
  if (webId == null && thorough) {
    const win = (await chrome.windows?.getLastFocused?.().catch(() => null)) || null;
    const tab = await chrome.tabs.create({ url: `${TIDAL_WEB_URL}/`, active: false, pinned: true, ...(win?.id != null ? { windowId: win.id } : {}) }).catch(() => null);
    if (tab) { webId = tab.id; await sessionSet({ tidalWebTab: tab.id }); await new Promise((r) => setTimeout(r, 8000)); }
  }
  if (webId == null) {
    add('tidal-tab', 'TIDAL tab', null, 'none open yet: the Player opens one (pinned) with the first song', '"Check now" in the settings opens it to test it.');
  } else {
    let check = await chrome.tabs.sendMessage(webId, { target: 'tidal-web', cmd: 'check' }).catch(() => undefined);
    if (check === undefined && thorough) {
      await chrome.tabs.reload(webId).catch(() => {});
      await new Promise((r) => setTimeout(r, 8000));
      check = await chrome.tabs.sendMessage(webId, { target: 'tidal-web', cmd: 'check' }).catch(() => undefined);
    }
    if (!check) {
      add('tidal-tab', 'TIDAL tab', thorough ? false : null, thorough ? "the Player's script doesn't answer in it" : 'open from before the Player was updated (reloaded with the next song)',
        thorough ? 'Close the TIDAL tab; the Player opens a new one with the next song.' : '');
    } else {
      add('tidal-tab', 'TIDAL tab', true, `open${check.visible ? '' : ' (in the background)'}`);
      add('tidal-web-signin', 'Signed in on tidal.com', check.signedIn === true ? true : check.signedIn === false ? false : null,
        check.signedIn ? 'yes' : check.signedIn === false ? 'no' : "can't tell (TIDAL's page is still loading?)",
        'Open the TIDAL tab and log in to tidal.com.');
      add('autoplay', 'TIDAL may play sound without a click', check.autoplay === 'allowed' ? true : check.autoplay === 'blocked' ? false : null,
        check.autoplay === 'allowed' ? 'yes (Chrome autoplay allow-list)' : check.autoplay === 'blocked' ? 'no' : "can't tell while the tab is in the background",
        check.autoplay === 'blocked' ? 'Run Install-Latest-Player.cmd, answer Yes to the admin prompt, then restart Chrome. (The Player can still start it for you.)' : '');
      const dbg = await evalAsUser(webId, '1');
      add('debugger', 'The Player can press Play in the TIDAL tab', dbg === 1, dbg === 1 ? 'yes' : 'Chrome refused', 'Reload the Player on chrome://extensions.');
    }
  }

  // Lyrics (subtitles for songs without them)
  try {
    const r = await fetch('https://lrclib.net/api/search?q=queen%20bohemian%20rhapsody', { headers: { 'Lrclib-Client': 'YoutubeHDx Player' } });
    add('lyrics', 'Lyrics service (LRCLIB)', r.ok, r.ok ? 'reachable' : `answered ${r.status}`, 'Try again later; songs without subtitles show none meanwhile.');
  } catch (e) {
    add('lyrics', 'Lyrics service (LRCLIB)', false, 'not reachable', 'Check the internet connection.');
  }

  // Backup and log folder on the NAS
  const dir = await yhdxGetBackupDir();
  const perm = dir ? await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt') : null;
  if (!dir) add('folder', 'Backup and log folder (NAS)', false, 'not chosen', 'Player settings → Choose NAS folder… (e.g. F:\\Music (videos)\\Software\\YoutubeHDx\\Backups).');
  else if (perm !== 'granted') add('folder', 'Backup and log folder (NAS)', false, `${dir.name}: Chrome needs your OK again`, 'Player settings → Allow the NAS folder again.');
  else {
    const w = await writeLogFile().catch((e) => `error: ${e?.message || e}`);
    add('folder', 'Backup and log folder (NAS)', w === 'ok', w === 'ok' ? `${dir.name}: writes fine` : `${dir.name}: ${w}`, 'Check that the NAS is on and the folder still exists; then choose it again.');
  }

  const { errorLog: errs = [] } = await chrome.storage.local.get({ errorLog: [] });
  const recent = errs.filter((e) => Date.now() - e.at < 24 * 3600e3).reduce((n, e) => n + (e.count || 1), 0);
  add('errors', 'Errors in the last 24 hours', recent === 0 ? true : null, recent ? `${recent} (see "Errors" below; in the NAS folder too)` : 'none');

  const problems = items.filter((i) => i.ok === false);
  const result = { at: Date.now(), thorough, version: chrome.runtime.getManifest?.().version ?? '', items, problems: problems.length };
  await chrome.storage.local.set({ readyCheck: result });
  await chrome.action?.setBadgeText?.({ text: problems.length ? '!' : '' }).catch(() => {});
  await chrome.action?.setBadgeBackgroundColor?.({ color: '#d93025' }).catch(() => {});
  await chrome.action?.setTitle?.({ title: problems.length ? `YoutubeHDx Player: ${problems.length} thing(s) to fix — click for the settings` : 'YoutubeHDx Player settings' }).catch(() => {});
  tidalLog({ video: '', step: 'ready check', outcome: problems.length ? `${problems.length} problem(s)` : 'everything ready',
    detail: items.map((i) => `${i.ok === true ? 'OK' : i.ok === false ? 'PROBLEM' : '?'} ${i.label}: ${i.detail}`).join(' · ') });
  return result;
}

chrome.runtime.onStartup?.addListener(() => setTimeout(() => readyCheck().catch(() => {}), READY_STARTUP_DELAY_MS));
chrome.runtime.onInstalled?.addListener(() => setTimeout(() => readyCheck().catch(() => {}), READY_STARTUP_DELAY_MS));

// ---------------------------------------------------------------- the small Sync window
// A popup window you can drag to another monitor; it opens where you left it last time.
const SYNC_SIZE = { width: 400, height: 300 };

async function openSyncWindow(tabId) {
  const old = await sessionGet('syncWindow');
  if (old != null) await chrome.windows.remove(old).catch(() => {});
  const { syncWindowBounds: b } = await chrome.storage.local.get({ syncWindowBounds: null });
  const base = { url: chrome.runtime.getURL(`sync.html?tab=${tabId}`), type: 'popup', focused: true, ...SYNC_SIZE };
  const placed = b && Number.isFinite(b.left) && Number.isFinite(b.top)
    ? { ...base, left: Math.round(b.left), top: Math.round(b.top),
        width: Math.max(320, Math.round(b.width) || SYNC_SIZE.width), height: Math.max(240, Math.round(b.height) || SYNC_SIZE.height) }
    : base;
  // A place that's no longer on any screen (a monitor unplugged) is refused: then Chrome's default place.
  const w = (await chrome.windows.create(placed).catch(() => null)) || (placed !== base ? await chrome.windows.create(base).catch(() => null) : null);
  if (w) await sessionSet({ syncWindow: w.id });
}

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
// The TIDAL tab to play in, in the video's window: there the Player can bring it to the front for a moment (a TIDAL
// tab in a window behind a full-screen video stays "hidden" to Chrome and can't start). Yours if one is open there,
// else a new pinned one in the background of that window.
async function ensureWebTab(trackId, ytTabId) {
  const yt = ytTabId != null ? await chrome.tabs.get(ytTabId).catch(() => null) : null;
  const win = yt?.windowId;
  const known = await webTab();
  const knownTab = known != null ? await chrome.tabs.get(known).catch(() => null) : null;
  if (knownTab && (win == null || knownTab.windowId === win)) return { id: known, fresh: false };
  const open = await chrome.tabs.query({ url: ['https://tidal.com/*', 'https://listen.tidal.com/*'] }).catch(() => []);
  const here = open.find((t) => win != null && t.windowId === win);
  let pick = here || (knownTab ? null : open[0]);
  if (!pick && knownTab && win == null) pick = knownTab;
  if (pick) {
    if (known != null && pick.id !== known) chrome.tabs.sendMessage(known, { target: 'tidal-web', cmd: 'stop' }).catch(() => {});
    await sessionSet({ tidalWebTab: pick.id });
    return { id: pick.id, fresh: false };
  }
  if (known != null) chrome.tabs.sendMessage(known, { target: 'tidal-web', cmd: 'stop' }).catch(() => {});
  const tab = await chrome.tabs.create({ url: `${TIDAL_WEB_URL}/track/${trackId}`, active: false, pinned: true, ...(win != null ? { windowId: win } : {}) });
  await sessionSet({ tidalWebTab: tab.id });
  return { id: tab.id, fresh: true };
}

// Chrome doesn't start sound in a background tab it has never shown (it waits until you look at it); a tab that has
// played once can go on loading songs in the background. So the TIDAL tab stays open between songs (paused: TIDAL never
// goes on to other songs by itself), and a new one is shown for a moment — then the video's tab is back in front.
const PEEK_MS = 800; // at least this long in front
const webPlayed = new Set(); // TIDAL tabs that have played since their page loaded
const ytFullscreen = new Map(); // video tab -> full screen (from its clock)
let peeking = null;

async function peekWebTab(webId, ytId, during) {
  if (peeking || webPlayed.has(webId)) return false;
  const web = await chrome.tabs.get(webId).catch(() => null);
  if (!web || web.active) return false;
  const win = await chrome.windows?.get(web.windowId).catch(() => null);
  if (win?.state === 'minimized') return false;
  const yt = ytId != null ? await chrome.tabs.get(ytId).catch(() => null) : null;
  const sameWindow = !!yt && yt.windowId === web.windowId;
  const back = sameWindow ? yt.id : (await chrome.tabs.query({ active: true, windowId: web.windowId }).catch(() => []))[0]?.id;
  // Switching tabs takes a full-screen video out of full screen: put it back right after (YouTube's own button).
  const refullscreen = sameWindow && yt.active && ytFullscreen.get(yt.id) === true;
  peeking = (async () => {
    await chrome.tabs.update(webId, { active: true }).catch(() => {});
    const shownAt = Date.now();
    if (during) await during();
    await new Promise((r) => setTimeout(r, Math.max(0, PEEK_MS - (Date.now() - shownAt))));
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
    const { id, fresh } = await ensureWebTab(msg.trackId, tabId);
    webLoad = { ...msg, target: 'tidal-web' };
    if (msg.title) trackTitles.set(String(msg.trackId), String(msg.title));
    // A new tab gets it with its "hello". A TIDAL tab open since before the Player was updated has no live copy of the
    // Player's script (Chrome doesn't add it to open tabs): reload it, and it says hello.
    const unheard = await chrome.tabs.sendMessage(id, webLoad).then(() => false,
      (e) => /Receiving end does not exist|Could not establish connection/i.test(String(e?.message || e)));
    tidalLog({ video: String(msg.title || trackTitles.get(String(msg.trackId)) || ''), step: 'player',
      outcome: fresh ? 'opened a TIDAL tab for it' : unheard ? 'TIDAL tab did not answer: reloading it' : 'gave it to your TIDAL tab', track: `[${msg.trackId}]` });
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
const AUTO_START_WAIT_MS = 10000; // TIDAL can take several seconds to start a song
const PEEK_SETTLE_MS = 1000; // the TIDAL tab in front this long (it may start by itself) before its Play is pressed
const PEEK_MAX_MS = 10000;   // at most this long in front, waiting for TIDAL to sound (it can take ~5-10 s)

// Reload the TIDAL tab (a clean TIDAL player) and wait until it has our song on its page again (its "need-click").
const RELOAD_WAIT_MS = 15000;
let reloadWaiter = null;
function reloadWebTab(tabId) {
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(t); if (reloadWaiter === w) reloadWaiter = null; resolve(ok); };
    const t = setTimeout(() => done(false), RELOAD_WAIT_MS);
    const w = reloadWaiter = { tabId, done };
    chrome.tabs.reload(tabId).catch(() => done(false));
  });
}

// Resolves true when TIDAL reports it plays, false after ms.
function waitForSound(key, ms) {
  return new Promise((resolve) => {
    if (autoStart.waiting !== key) { resolve(true); return; } // already sounded
    const done = (ok = false) => { clearTimeout(t); if (autoStart.sounded === done) autoStart.sounded = null; resolve(ok); };
    const t = setTimeout(() => done(false), ms);
    autoStart.sounded = done;
  });
}
const autoStart = { tried: new Set(), timer: null, waiting: null };

// Runs a script in a tab as if you had clicked (Chrome's debugger, attached for a moment). Returns its value, or
// 'no-access' when Chrome won't let the Player in. One attachment per tab, kept for a moment between calls.
const attached = new Map(); // tabId -> pending detach timer
async function evalAsUser(tabId, expression) {
  if (!chrome.debugger) return 'no-access';
  const target = { tabId };
  if (attached.has(tabId)) clearTimeout(attached.get(tabId));
  else {
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      if (!/already attached/i.test(String(e?.message || e))) return 'no-access';
    }
  }
  attached.set(tabId, null);
  try {
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, userGesture: true, returnByValue: true, awaitPromise: true });
    return r?.result?.value ?? null;
  } catch {
    return 'no-access';
  } finally {
    attached.set(tabId, setTimeout(() => { attached.delete(tabId); chrome.debugger.detach(target).catch(() => {}); }, 500));
  }
}
chrome.debugger?.onDetach?.addListener?.((source) => { if (source.tabId != null) { clearTimeout(attached.get(source.tabId)); attached.delete(source.tabId); } });

async function autoStartWebTab(tabId, trackId, checkOnly = false) {
  if (!/^\d{1,15}$/.test(String(trackId))) return false;
  // The song is usually already in TIDAL's player bar, paused (its first start was blocked): press the bar's Play.
  // Pressing the song's row again doesn't start an already-loaded song.
  const expression = `(() => {
    const bar = document.querySelector('[data-test="footer-player"]');
    const link = bar && bar.querySelector('[data-test="footer-track-title"] a[href*="/track/"]');
    const play = bar && bar.querySelector('[data-test="play"]');
    const ours = link && /\\/track\\/${trackId}(\\D|$)/.test(link.getAttribute('href') || '');
    const checkOnly = ${checkOnly ? 'true' : 'false'};
    if (ours && play) { if (checkOnly) return 'paused'; play.click(); return 'footer'; }
    // Our song with Pause showing: TIDAL is already starting it (Chrome may still be holding the sound). Clicking
    // anything now would stop it.
    if (ours && bar.querySelector('[data-test="pause"]')) {
      // ... unless it has loaded nothing at all: TIDAL's player is stuck (a start Chrome held back); only a reload
      // of the tab clears that.
      const empty = [...document.querySelectorAll('video, audio')].every((m) => !m.currentSrc || (m.readyState === 0 && m.networkState === 3));
      return empty ? 'stuck' : 'starting';
    }
    const row = document.querySelector('[data-test="tracklist-row"][data-track-id="${trackId}"]');
    const b = row && (row.querySelector('[data-test="play-button"]') || row);
    if (b && checkOnly) return 'not ours';
    if (b) { b.click(); return 'row'; }
    return 'none';
  })()`;
  return (await evalAsUser(tabId, expression)) || 'none'; // footer | row | starting | stuck | none
}
const PRESSED = { footer: "pressed Play in TIDAL's player bar", row: 'pressed the song in TIDAL', starting: 'TIDAL was already starting it' };

async function onWebHello(tabId) {
  const known = await webTab();
  if (known != null && known !== tabId) return; // another TIDAL tab of yours: left alone
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
        errorLog({ where: 'TIDAL search', message: `${String(msg.title || '').slice(0, 80)}: ${e?.message || e}`, stack: e?.stack });
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
    case 'yhdx-error':
      // From the Player's own scripts only (its pages and its content scripts).
      if (sender.id !== chrome.runtime.id) return false;
      errorLog({ where: isExtensionPage(sender) || !sender.tab ? String(msg.where || 'page')
                   : `${String(msg.where || 'page')} (${/tidal\.com/.test(sender.url || '') ? 'TIDAL tab' : 'YouTube page'})`,
                 message: msg.message, stack: msg.stack });
      return false;
    case 'error-log':
      if (!isExtensionPage(sender)) return false;
      chrome.storage.local.get({ errorLog: [] }).then(({ errorLog: log }) => sendResponse(log));
      return true;
    case 'error-log-clear':
      if (!isExtensionPage(sender)) return false;
      chrome.storage.local.set({ errorLog: [] }).then(() => sendResponse(true));
      return true;
    case 'ready-check':
      if (!isExtensionPage(sender)) return false;
      readyCheck({ thorough: !!msg.thorough }).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    case 'backup-now':
      if (!isExtensionPage(sender)) return false;
      clearTimeout(backupTimer);
      Promise.all([runBackup(), writeLogFile()]).then(([b]) => sendResponse(b), (e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    case 'tidal-pick':
      // "Use the song in my TIDAL tab for this video": which song is in your TIDAL tab's player bar, and where.
      if (sender.tab?.id == null) return false;
      (async () => {
        let id = await webTab();
        if (id == null) id = (await chrome.tabs.query({ url: ['https://tidal.com/*', 'https://listen.tidal.com/*'] }).catch(() => []))[0]?.id ?? null;
        const now = id == null ? null : await chrome.tabs.sendMessage(id, { target: 'tidal-web', cmd: 'which' }).catch(() => null);
        if (now?.id) {
          await sessionSet({ tidalWebTab: id });
          trackTitles.set(String(now.id), String(msg.title || ''));
          tidalLog({ video: String(msg.title || ''), step: 'match', outcome: 'you chose the song in your TIDAL tab', track: `${now.artist} – ${now.title} [${now.id}]` });
        }
        sendResponse(now?.id ? now : null);
      })();
      return true;
    case 'tidal-sync-open':
      // The ⇄ menu / the "♪ TIDAL" label: the small Sync window for this video.
      if (sender.tab?.id != null) openSyncWindow(sender.tab.id);
      return false;
    case 'tidal-sync':
      // From the Sync window: to the video's tab.
      if (!isExtensionPage(sender) || !Number.isInteger(msg.tabId)) return false;
      chrome.tabs.sendMessage(msg.tabId, { type: 'tidal-sync', cmd: String(msg.cmd || ''), delta: Number(msg.delta) || 0, on: !!msg.on })
        .then(() => sendResponse(true), () => sendResponse(false));
      return true;
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
        const m = { type: 'tidal-audio-status', status: String(msg.status || ''), trackId: msg.trackId ?? null, quality: msg.quality ?? null, via: 'web',
          ...(msg.detail ? { message: String(msg.detail).slice(0, 600) } : {}) };
        if (m.status === 'diag') { logPlayer(m); return; } // only for the log
        if (m.status === 'unavailable') {
          // TIDAL itself can't play this track here: stop trying to start it, and never pick it again.
          clearTimeout(autoStart.timer);
          autoStart.waiting = null;
          autoStart.sounded?.(true);
          await markUnplayable(m.trackId);
        }
        const forward = () => { logPlayer(m); if (tab != null) chrome.tabs.sendMessage(tab, m).catch(() => {}); };
        if (m.status === 'need-click' && reloadWaiter && reloadWaiter.tabId === sender.tab?.id) {
          reloadWaiter.done(true); // the reloaded TIDAL tab has our song on its page again: the Player presses Play
          return;
        }
        if (m.status === 'need-click') {
          // Do the click for you first; only if TIDAL still isn't playing a few seconds later, ask you.
          const key = `${sender.tab?.id}:${m.trackId}`;
          const fromTidal = /^https:\/\/(listen\.)?tidal\.com\//.test(String(sender.url || sender.tab?.url || ''));
          if (sender.tab?.id != null && fromTidal && !autoStart.tried.has(key)) {
            autoStart.tried.add(key);
            const webId = sender.tab.id;
            const title = trackTitles.get(String(m.trackId)) || '';
            const log = (outcome, detail) => tidalLog({ video: title, step: 'player', outcome, track: `[${m.trackId}]`, ...(detail ? { detail } : {}) });
            // Press Play as you would; TIDAL stuck (Pause, nothing loaded) -> reload its tab and press again.
            const startIt = async (soundMs) => {
              for (let attempt = 1; attempt <= 2; attempt++) {
                const how = await autoStartWebTab(webId, m.trackId);
                if (PRESSED[how]) {
                  log(`started TIDAL for you: ${PRESSED[how]}`);
                  if (await waitForSound(key, soundMs)) return true;
                  if (attempt === 2) return false;
                  if ((await autoStartWebTab(webId, m.trackId, true)) !== 'stuck') return false;
                  log('TIDAL is stuck (Pause, nothing loaded): reloading its tab and starting again');
                } else if (how === 'stuck') {
                  log('TIDAL is stuck (Pause, nothing loaded): reloading its tab and starting again');
                } else {
                  log(`couldn't press Play in the TIDAL tab (${how === 'none' ? "the song isn't on its page" : how === 'no-access' ? 'Chrome refused the Player access to the tab' : how})`);
                  return false;
                }
                if (!(await reloadWebTab(webId, m.trackId))) { log('the TIDAL tab did not come back after the reload'); return false; }
              }
              return false;
            };
            clearTimeout(autoStart.timer);
            autoStart.waiting = key;
            if (webPlayed.has(webId)) {
              autoStart.timer = setTimeout(forward, AUTO_START_WAIT_MS + RELOAD_WAIT_MS);
              if (!(await startIt(AUTO_START_WAIT_MS))) { clearTimeout(autoStart.timer); if (autoStart.waiting === key) { autoStart.waiting = null; forward(); } }
              return;
            }
            // A TIDAL tab that hasn't played since it loaded: Chrome starts its sound only while it's on screen. Show it,
            // press Play while it's in front, and go back to the video once TIDAL sounds.
            autoStart.timer = setTimeout(forward, PEEK_MAX_MS * 2 + RELOAD_WAIT_MS + 5000);
            let ok = false;
            const shown = await peekWebTab(webId, tab, async () => {
              // On screen, a song TIDAL was already starting goes on by itself: give it a moment before pressing Play.
              if (await waitForSound(key, PEEK_SETTLE_MS)) { ok = true; return; }
              ok = await startIt(PEEK_MAX_MS);
              if (ok) return;
              // Still silent while on screen: note what the TIDAL tab shows, for the log.
              chrome.tabs.sendMessage(webId, { target: 'tidal-web', cmd: 'diag' }).catch(() => {});
              await new Promise((r) => setTimeout(r, 300));
            });
            if (shown) log(`showed the TIDAL tab to start it (Chrome starts sound only in a tab on screen)${ok ? '' : ': still silent'}`);
            else { log("couldn't show the TIDAL tab (minimized window?): pressing Play there anyway"); ok = await startIt(AUTO_START_WAIT_MS); }
            if (!ok) { clearTimeout(autoStart.timer); if (autoStart.waiting === key) { autoStart.waiting = null; forward(); } }
            return;
          }
          forward();
          return;
        }
        if (m.status === 'loaded' || m.status === 'playing') {
          clearTimeout(autoStart.timer);
          autoStart.waiting = null;
          if (sender.tab?.id != null) webPlayed.add(sender.tab.id);
          autoStart.sounded?.(true);
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
