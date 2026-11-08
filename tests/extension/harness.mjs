// Loads the real extension scripts into a sandbox with a fake YouTube page / fake chrome.* API.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const playerDir = fileURLToPath(new URL('../../extension-player/', import.meta.url));
const downloaderDir = fileURLToPath(new URL('../../extension-downloader/', import.meta.url));
export const playerSource = (name) => readFileSync(playerDir + name, 'utf8');
export const downloaderSource = (name) => readFileSync(downloaderDir + name, 'utf8');
export const readManifest = (which) =>
  JSON.parse(readFileSync((which === 'player' ? playerDir : downloaderDir) + 'manifest.json', 'utf8'));

// Timers are looked up at call time so node:test's mock.timers can take over.
const timerApi = {
  setTimeout: (...a) => globalThis.setTimeout(...a),
  clearTimeout: (...a) => globalThis.clearTimeout(...a),
  setInterval: (...a) => globalThis.setInterval(...a),
  clearInterval: (...a) => globalThis.clearInterval(...a),
};

/** defaults.js as a module-like object. */
export function loadDefaults() {
  const ctx = vm.createContext({});
  vm.runInContext(playerSource('defaults.js') + '\n;globalThis.__x = { YHDX_DEFAULTS, yhdxBuildCaptionCss, yhdxHexToRgba, yhdxBuildHideCss, yhdxBuildPageCss };', ctx);
  return ctx.__x;
}

// ---------------- fake YouTube player page (for content-main.js) ----------------

export class FakePlayer {
  constructor({ videoId = 'vid1', levels = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'auto'], tracks = [], lazyTracks = false,
                title = 'Peter Schilling - Major Tom (Coming Home) (Official Video)', author = 'Peter Schilling', duration = 300 } = {}) {
    this.videoId = videoId;
    this.title = title;
    this.author = author;
    this.duration = duration;
    this.children = [];
    this.levels = levels;
    this.tracks = tracks;
    this.lazyTracks = lazyTracks;      // tracklist empty until loadModule('captions')
    this.captionsLoaded = !lazyTracks;
    this.ad = false;
    this.time = 42;
    this.currentTrack = null;
    this.calls = [];
    this.classList = { contains: (c) => c === 'ad-showing' && this.ad };
    this.volume = 80;
    this.muted = false; // YouTube's own mute button
    // The <video> element YouTube plays into.
    this.video = {
      muted: false, paused: false, seeking: false, readyState: 4, playbackRate: 1, listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
      removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); },
      fire(t) { for (const fn of this.listeners[t] ?? []) fn({}); },
    };
  }
  getVolume() { return this.volume; }
  isMuted() { return this.muted; }
  getVideoData() { return { video_id: this.videoId, title: this.title, author: this.author }; }
  getDuration() { return this.duration; }
  appendChild(el) { this.children.push(el); el.parent = this; }
  getAvailableQualityLevels() { return this.levels; }
  setPlaybackQualityRange(a, b) { this.calls.push(['setPlaybackQualityRange', a, b]); }
  setPlaybackQuality(q) { this.calls.push(['setPlaybackQuality', q]); }
  getOption(module, option) {
    if (module === 'captions' && option === 'tracklist') return this.captionsLoaded ? this.tracks : [];
    if (module === 'captions' && option === 'track') return this.currentTrack;
    return undefined;
  }
  setOption(module, option, value) {
    this.calls.push(['setOption', module, option, value]);
    if (module === 'captions' && option === 'track') this.currentTrack = value?.languageCode ? value : null;
  }
  getCurrentTime() { return this.time; }
  querySelector(sel) {
    if (sel === '.ytp-right-controls') return this.controls ?? null;
    if (sel.startsWith('video')) return this.video;
    return null;
  }
  loadVideoById(arg) { this.calls.push(['loadVideoById', arg]); }
  loadModule(m) { this.calls.push(['loadModule', m]); if (m === 'captions') this.captionsLoaded = true; }
  unloadModule(m) { this.calls.push(['unloadModule', m]); }
  callsNamed(name) { return this.calls.filter((c) => c[0] === name); }
}

export function createYoutubePage({ player = new FakePlayer(), pathname = '/watch' } = {}) {
  const winListeners = {};
  const docListeners = {};
  const elements = new Map();
  const posted = [];
  class HTMLVideoElement {}

  const document = {
    head: { appendChild: (el) => elements.set(el.id, el) },
    documentElement: { appendChild: (el) => elements.set(el.id, el) },
    getElementById: (id) => (id === 'movie_player' ? page.player : elements.get(id) ?? null),
    createElement: (tag) => {
      const el = { tagName: tag.toUpperCase(), id: '', className: '', textContent: '', style: {}, children: [] };
      el.appendChild = (child) => { el.children.push(child); child.parent = el; child.parentElement = el; };
      el.prepend = (child) => { el.children.unshift(child); child.parent = el; child.parentElement = el; };
      el.insertBefore = (child, ref) => {
        const i = el.children.indexOf(ref);
        el.children.splice(i < 0 ? el.children.length : i, 0, child);
        child.parent = el; child.parentElement = el;
      };
      el.contains = (child) => el.children.some((c) => c === child || c.contains?.(child));
      el.querySelector = (sel) => {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        for (const c of el.children) {
          if (cls && String(c.className).split(' ').includes(cls)) return c;
          const deep = c.querySelector?.(sel);
          if (deep) return deep;
        }
        return null;
      };
      el.classList = {
        add: (c) => { const set = new Set(String(el.className).split(' ').filter(Boolean)); set.add(c); el.className = [...set].join(' '); },
        remove: (c) => { el.className = String(el.className).split(' ').filter((x) => x && x !== c).join(' '); },
        contains: (c) => String(el.className).split(' ').includes(c),
      };
      el.querySelectorAll = (sel) => {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        const out = [];
        const walk = (n) => { for (const c of n.children ?? []) { if (cls && String(c.className).split(' ').includes(cls)) out.push(c); walk(c); } };
        walk(el);
        return out;
      };
      el.attrs = {};
      el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
      el.listeners = {};
      el.addEventListener = (type, fn) => (el.listeners[type] ??= []).push(fn);
      el.click = () => { for (const fn of el.listeners.click ?? []) fn({ stopPropagation() {} }); };
      el.remove = () => {
        elements.delete(el.id);
        if (el.parent?.children) el.parent.children = el.parent.children.filter((c) => c !== el);
        el.removed = true;
      };
      return el;
    },
    querySelector: (sel) => {
      if (sel.includes(':not(.yhdx-lyrics)')) return page.youtubeCaptionsShowing ? {} : null;
      if (sel === '.ytp-contextmenu .ytp-panel-menu') return page.contextMenu?.panel ?? null;
      if (sel === '.ytp-contextmenu') return page.contextMenu ?? null;
      return null;
    },
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
  };

  const window = {
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
    postMessage: (data) => {
      posted.push(data);
      // Stand-in for the bridge's per-video subtitle choices (answers immediately unless turned off).
      if (data?.__yhdx === 'prefs-save') page.savedPrefs[data.videoId] = JSON.parse(JSON.stringify(data.prefs));
      if (data?.__yhdx === 'prefs-request' && page.answerPrefs) {
        const prefs = JSON.parse(JSON.stringify(page.savedPrefs[data.videoId] ?? {}));
        for (const fn of winListeners.message ?? []) fn({ source: window, data: { __yhdx: 'prefs', videoId: data.videoId, prefs } });
      }
    },
  };

  const page = {
    player,
    posted,
    savedPrefs: {},
    answerPrefs: true,
    youtubeCaptionsShowing: false,
    /** The bridge answering a lyrics request. */
    sendLyrics(videoId, cues, meta = {}) {
      for (const fn of winListeners.message ?? []) fn({ source: window, data: { __yhdx: 'lyrics', videoId, cues, ...meta } });
    },
    /** The lyrics line the extension drew (or undefined). */
    lyricsWindow() { return page.player.children.find((c) => c.className === 'yhdx-lyrics-window' && !c.removed); },
    elements,
    HTMLVideoElement,
    location: { pathname, origin: 'https://www.youtube.com' },
    /** What the isolated-world bridge does: hand over settings + caption CSS. */
    sendSettings(settings, captionCss = '') {
      for (const fn of winListeners.message ?? []) fn({ source: window, data: { __yhdx: 'settings', settings, captionCss } });
    },
    fireWindow(type) { for (const fn of winListeners[type] ?? []) fn({}); },
    fireMessage(data) { for (const fn of winListeners.message ?? []) fn({ source: window, data }); },
    /** The bridge answering a TIDAL match request. */
    sendTidalMatch(videoId, track, extra = {}) {
      for (const fn of winListeners.message ?? []) fn({ source: window, data: { __yhdx: 'tidal-match', videoId, track, ...extra } });
    },
    /** Status from the TIDAL player (via service worker and bridge). */
    sendAudioStatus(status, extra = {}) {
      for (const fn of winListeners.message ?? []) fn({ source: window, data: { __yhdx: 'tidal-audio-status', status, ...extra } });
    },
    /** Right-click on the video: YouTube shows its menu, then our listener fills it. */
    rightClick() {
      page.contextMenu = page.makeElement('div');
      page.contextMenu.style = { display: '' };
      page.contextMenu.panel = page.makeElement('div');
      page.contextMenu.panel.className = 'ytp-panel-menu';
      for (const fn of docListeners.contextmenu ?? []) fn({ target: page.player });
    },
    fireVideoLoaded() {
      for (const fn of docListeners.loadeddata ?? []) fn({ target: new HTMLVideoElement() });
    },
  };

  // Fake network layer the player uses for caption requests. content-main.js wraps these (read-only).
  const xhrLog = [];
  class FakeXHR {
    constructor() { this.listeners = {}; this.responseType = ''; this.status = 0; this.responseText = ''; this.response = null; }
    open(method, url) { this.method = method; this.url = url; }
    send(body) { this.sentBody = body; xhrLog.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    finish(status, body) {
      this.status = status;
      this.responseText = typeof body === 'string' ? body : '';
      this.response = body;
      for (const fn of this.listeners.loadend ?? []) fn();
    }
  }
  let fetchReply = null;
  const fakeFetch = async () => fetchReply();

  page.makeElement = (tag) => document.createElement(tag);
  // YouTube's control bar (right side), where the out-of-sync button goes.
  player.controls = document.createElement('div');
  player.controls.className = 'ytp-right-controls';
  /** Elements the extension added to the player, by class. */
  page.inPlayer = (cls) => page.player.children.filter((c) => !c.removed && String(c.className).split(' ').includes(cls));
  const findDeep = (el, pred) => { for (const c of el.children ?? []) { if (pred(c)) return c; const d = findDeep(c, pred); if (d) return d; } return null; };
  page.syncButton = () => findDeep(player.controls, (c) => String(c.className).includes('yhdx-sync-button')) ?? undefined;
  page.menu = () => page.inPlayer('yhdx-sync-menu')[0];
  page.menuItems = () => (page.menu()?.children ?? []).filter((c) => c.className === 'yhdx-item').map((c) => c.textContent);
  page.chooseMenu = (label) => {
    const item = page.menu()?.children.find((c) => c.className === 'yhdx-item' && c.textContent === label);
    if (!item) throw new Error(`menu item "${label}" not found; have: ${page.menuItems().join(' | ')}`);
    item.click();
  };
  page.toastText = () => page.inPlayer('yhdx-toast')[0]?.textContent;

  const ctx = vm.createContext({
    window, document, location: page.location, HTMLVideoElement, URL, ArrayBuffer, JSON,
    XMLHttpRequest: FakeXHR, fetch: fakeFetch, ...timerApi,
  });
  vm.runInContext(playerSource('content-main.js'), ctx);

  page.xhrLog = xhrLog;
  /** The player asking for captions over XHR; returns the request so the test can finish it. */
  page.captionXhr = (url) => {
    const x = new ctx.XMLHttpRequest();
    x.open('GET', url);
    x.send();
    return x;
  };
  /** The player asking for captions over fetch. */
  page.captionFetch = (url, status, body) => {
    fetchReply = () => new Response(body, { status });
    return ctx.fetch(url);
  };
  return page;
}

/** lyrics.js functions. */
export function loadLyrics() {
  const ctx = vm.createContext({ URL, encodeURIComponent, JSON, Error });
  vm.runInContext(playerSource('lyrics.js') + `
;globalThis.__l = { yhdxParseVideoTitle, yhdxParseLrc, yhdxParseSrt, yhdxPickLrclib, yhdxSubsFitVideo, yhdxFindLyrics,
                    yhdxCleanAuthor };`, ctx);
  return ctx.__l;
}

/** Player background.js with lyrics.js (importScripts) and fake chrome storage + fetch. */
export function loadPlayerBackground({ fetchFn, openSubtitlesKey = '', now = () => Date.now(), session = {} } = {}) {
  const local = { openSubtitlesKey };
  const onMessage = [];
  const sentToRuntime = [];
  const sentToTabs = [];
  const chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      openOptionsPage: () => {},
      onMessage: { addListener: (fn) => onMessage.push(fn) },
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async (m) => { sentToRuntime.push(m); },
    },
    tabs: { sendMessage: async (id, m) => { sentToTabs.push([id, m]); }, onRemoved: { addListener: () => {} } },
    offscreen: {
      hasDocument: async () => offscreen.open,
      // the page loads and says it's ready, like the real offscreen.js
      createDocument: async (o) => { offscreen.open = true; offscreen.created.push(o); setTimeout(() => dispatch({ type: 'tidal-offscreen-ready' }), 0); },
    },
    identity: { getRedirectURL: (p) => `https://test.chromiumapp.org/${p}`, launchWebAuthFlow: async (o) => identity(o) },
    storage: {
      local: {
        get: async (q) => {
          if (typeof q === 'string') return q in local ? { [q]: local[q] } : {};
          const out = { ...q };
          for (const k of Object.keys(q)) if (k in local) out[k] = local[k];
          return out;
        },
        set: async (obj) => Object.assign(local, obj),
        remove: async (k) => { for (const key of [].concat(k)) delete local[key]; },
      },
      session: {
        get: async (q) => { const out = { ...q }; for (const k of Object.keys(q)) if (k in session) out[k] = session[k]; return out; },
        set: async (obj) => Object.assign(session, obj),
      },
    },
  };
  const offscreen = { open: false, created: [] };
  let identity = async () => { throw new Error('no sign-in in this test'); };
  const ctx = vm.createContext({
    chrome, URL, URLSearchParams, encodeURIComponent, JSON, Error, fetch: (...a) => fetchFn(...a),
    Date: { now }, TextEncoder, btoa, crypto: globalThis.crypto, String, Number, Promise, setTimeout, clearTimeout,
  });
  ctx.importScripts = (name) => vm.runInContext(playerSource(name), ctx);
  vm.runInContext(playerSource('background.js'), ctx);
  const dispatch = (msg, sender = {}) => new Promise((resolve) => {
    let handled = false;
    for (const fn of onMessage) if (fn(msg, sender, resolve) === true) handled = true;
    if (!handled) resolve(undefined);
  });
  return {
    local,
    session,
    offscreen,
    sentToRuntime,
    sentToTabs,
    setIdentity: (fn) => { identity = fn; },
    ask: (msg) => dispatch({ type: 'lyrics', ...msg }),
    send: dispatch,
  };
}

/** Runs defaults.js + content-bridge.js (isolated world) with the given saved settings; returns what it posts. */
export async function runBridge(saved = {}, { lyricsReply = null, onSend = () => {}, local = {}, reply = null } = {}) {
  const posted = [];
  const listeners = [];
  const runtimeListeners = [];
  const window = { addEventListener: (t, fn) => listeners.push(fn), postMessage: (data) => posted.push(data) };
  const chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: async (msg) => { onSend(msg); return reply ? reply(msg) : lyricsReply; },
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
    storage: {
      sync: { get: async (defaults) => ({ ...structuredClone(defaults), ...saved }) },
      local: {
        get: async (key) => (key in local ? { [key]: structuredClone(local[key]) } : {}),
        set: async (obj) => Object.assign(local, structuredClone(obj)),
        remove: async (key) => { delete local[key]; },
      },
      onChanged: { addListener: () => {} },
    },
  };
  const ctx = vm.createContext({ window, chrome, location: { origin: 'https://www.youtube.com' }, structuredClone });
  vm.runInContext(playerSource('defaults.js') + '\n' + playerSource('content-bridge.js'), ctx);
  await new Promise((r) => setImmediate(r));
  posted.receive = async (data) => { for (const fn of listeners) fn({ source: window, data }); await new Promise((r) => setImmediate(r)); };
  posted.local = local;
  // The Player was updated/reloaded while this tab stayed open: chrome.* calls throw from now on.
  posted.invalidate = () => {
    delete chrome.runtime.id;
    const dead = async () => { throw new Error('Extension context invalidated.'); };
    chrome.runtime.sendMessage = dead;
    chrome.storage.local.get = dead; chrome.storage.local.set = dead; chrome.storage.local.remove = dead; chrome.storage.sync.get = dead;
  };
  posted.fromServiceWorker = async (msg) => { for (const fn of runtimeListeners) fn(msg, {}, () => {}); await new Promise((r) => setImmediate(r)); };
  return posted;
}

// ---------------- fake chrome.* (for background.js) ----------------

export function loadBackground({ cookies = [], nativeReply = { ok: true, message: 'queued' }, nativeError = null } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const sent = [];
  const badges = [];
  const menus = [];

  const chrome = {
    runtime: {
      onInstalled: on('installed'),
      onStartup: on('startup'),
      onMessage: on('message'),
      sendNativeMessage: async (host, msg) => {
        sent.push({ host, msg });
        if (nativeError) throw new Error(nativeError);
        return nativeReply;
      },
    },
    cookies: { getAll: async (q) => (q.domain === 'youtube.com' ? cookies : []) },
    action: {
      setBadgeText: async (b) => badges.push(b.text),
      setBadgeBackgroundColor: async () => {},
    },
    contextMenus: {
      onClicked: on('menuClicked'),
      removeAll: (cb) => { menus.length = 0; cb(); },
      create: (m) => menus.push(m),
    },
    alarms: { onAlarm: on('alarm'), create: () => {} },
  };

  const ctx = vm.createContext({ chrome, URL, ...timerApi });
  vm.runInContext(downloaderSource('background.js') + '\n;globalThis.__parse = parseYoutubeUrl;', ctx);

  return {
    parse: ctx.__parse,
    sent,
    badges,
    menus,
    listeners,
    /** Simulates chrome.runtime.sendMessage from the popup. */
    message: (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve)),
  };
}

/** tidal.js as a module-like object. */
export function loadTidal() {
  const ctx = vm.createContext({ TextEncoder, btoa, crypto: globalThis.crypto, URL, URLSearchParams });
  vm.runInContext(playerSource('tidal.js') + '\n;globalThis.__x = { yhdxSongParse, yhdxTidalSameSong, yhdxTidalPick, yhdxIsoSeconds, yhdxTidalSearch, yhdxTidalFind, yhdxTidalPresentation, yhdxTidalFindPlayable, yhdxSyncStep, yhdxPkce, yhdxTidalAuthorizeUrl, yhdxSongNorm };', ctx);
  return ctx.__x;
}
