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
  }
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
      el.appendChild = (child) => { el.children.push(child); child.parent = el; };
      el.remove = () => {
        elements.delete(el.id);
        if (el.parent?.children) el.parent.children = el.parent.children.filter((c) => c !== el);
        el.removed = true;
      };
      return el;
    },
    querySelector: (sel) => (sel.includes(':not(.yhdx-lyrics)') && page.youtubeCaptionsShowing ? {} : null),
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
  };

  const window = {
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
    postMessage: (data) => posted.push(data),
  };

  const page = {
    player,
    posted,
    youtubeCaptionsShowing: false,
    /** The bridge answering a lyrics request. */
    sendLyrics(videoId, cues) {
      for (const fn of winListeners.message ?? []) fn({ source: window, data: { __yhdx: 'lyrics', videoId, cues } });
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
export function loadPlayerBackground({ fetchFn, openSubtitlesKey = '', now = () => Date.now() } = {}) {
  const local = { openSubtitlesKey };
  let onMessage;
  const chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: { openOptionsPage: () => {}, onMessage: { addListener: (fn) => { onMessage = fn; } } },
    storage: {
      local: {
        get: async (q) => {
          if (typeof q === 'string') return q in local ? { [q]: local[q] } : {};
          const out = { ...q };
          for (const k of Object.keys(q)) if (k in local) out[k] = local[k];
          return out;
        },
        set: async (obj) => Object.assign(local, obj),
      },
    },
  };
  const ctx = vm.createContext({
    chrome, URL, encodeURIComponent, JSON, Error, fetch: (...a) => fetchFn(...a),
    Date: { now },
  });
  ctx.importScripts = (name) => vm.runInContext(playerSource(name), ctx);
  vm.runInContext(playerSource('background.js'), ctx);
  return {
    local,
    ask: (msg) => new Promise((resolve) => onMessage({ type: 'lyrics', ...msg }, {}, resolve)),
  };
}

/** Runs defaults.js + content-bridge.js (isolated world) with the given saved settings; returns what it posts. */
export async function runBridge(saved = {}, { lyricsReply = null, onSend = () => {} } = {}) {
  const posted = [];
  const listeners = [];
  const window = { addEventListener: (t, fn) => listeners.push(fn), postMessage: (data) => posted.push(data) };
  const chrome = {
    runtime: { sendMessage: async (msg) => { onSend(msg); return lyricsReply; } },
    storage: {
      sync: { get: async (defaults) => ({ ...structuredClone(defaults), ...saved }) },
      onChanged: { addListener: () => {} },
    },
  };
  const ctx = vm.createContext({ window, chrome, location: { origin: 'https://www.youtube.com' }, structuredClone });
  vm.runInContext(playerSource('defaults.js') + '\n' + playerSource('content-bridge.js'), ctx);
  await new Promise((r) => setImmediate(r));
  posted.receive = async (data) => { for (const fn of listeners) fn({ source: window, data }); await new Promise((r) => setImmediate(r)); };
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
