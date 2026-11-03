// Offscreen document: plays the TIDAL track with TIDAL's official web player (@tidal-music/player) and keeps it in
// step with the YouTube video. The YouTube tab sends its clock (video time, playing, speed) a few times a second;
// this page does the rest. Built into ../offscreen.js by tools/build-tidal-player.sh (npm + esbuild).
import * as Player from '@tidal-music/player';
import * as EventProducer from '@tidal-music/event-producer';

const TICK_MS = 100;
// Paused this long: end TIDAL's session (its play log is sent) and load again on play. Chrome closes this page soon
// after its sound stops anyway, so nothing would survive a long pause.
const PARK_MS = 5000;
const bus = [];
let current = null;   // {tabId, trackId, loaded, clock: {videoTime, playing, rate, offset, volume, sentAt}}
let loop = null;
// What happened last (read by the end-to-end test and handy in DevTools: chrome://extensions → offscreen.html).
const trace = [];
globalThis.yhdxTrace = trace;
globalThis.yhdxEvents = EventProducer; // DevTools: await yhdxEvents.flush() sends queued play logs now
const note = (s) => { trace.push(`${new Date().toISOString().slice(11, 23)} ${s}`); if (trace.length > 50) trace.shift(); };

const provider = {
  bus: (callback) => { bus.push(callback); },
  getCredentials: async () => {
    const c = await chrome.runtime.sendMessage({ type: 'tidal-credentials' });
    if (!c?.token) throw new Error('Not signed in to TIDAL');
    return c;
  },
};

// TIDAL's event sender starts by syncing its clock with TIDAL; if that fails (network blip at startup) it never
// starts sending, so retry until it does (15 s, 30 s, … up to every 5 min). Events wait in its queue meanwhile.
async function startEvents(version, attempt = 0) {
  try {
    await EventProducer.init({
      appInfo: { appName: 'YoutubeHDx Player', appVersion: version },
      blockedConsentCategories: { NECESSARY: false, PERFORMANCE: true, TARGETING: true },
      credentialsProvider: provider,
      platform: { browserName: 'Chrome', browserVersion: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '', osName: navigator.platform || '' },
      strictMode: false,
      tlConsumerUri: 'https://tidal.com/api/event-batch',
      tlPublicConsumerUri: 'https://tidal.com/api/public/event-batch',
    });
    note('play logs ready');
  } catch (e) {
    note(`play logs not ready (${e?.message || e}), retrying`);
    setTimeout(() => startEvents(version, attempt + 1), Math.min(300000, 15000 * 2 ** attempt));
  }
}

// Setup must never stop this page from listening (the YouTube tab would then wait forever): note failures instead.
function setup() {
  try {
    Player.setCredentialsProvider(provider);
    // Play logs go to TIDAL exactly like their own web player's (same endpoints), so plays count for the artists.
    let version = '1';
    try { version = chrome.runtime.getManifest?.().version || version; } catch { /* not available here */ }
    startEvents(version);
    Player.setEventSender({
      ...EventProducer,
      sendEvent: (e) => {
        note(`event ${e?.group}/${e?.name}`);
        return Promise.resolve(EventProducer.sendEvent(e)).catch((err) => note(`event not queued: ${err?.message || err}`));
      },
    });
    // The SDK's default is LOW (HE-AAC only). Ask for the best: TIDAL sends up to Hi-Res FLAC when the account allows.
    Player.setStreamingWifiAudioQuality('HI_RES_LOSSLESS');
    Player.bootstrap({ outputDevices: false, players: [{ itemTypes: ['track'], player: 'shaka' }] });
    note('setup ok');
  } catch (e) {
    note(`setup failed: ${e?.message || e}`);
  }
}
setup();

function report(status, extra = {}) {
  if (!current) return;
  chrome.runtime.sendMessage({ type: 'tidal-audio-status', tabId: current.tabId, trackId: current.trackId, status, ...extra }).catch(() => {});
}

async function load(msg) {
  stop(false);
  current = { tabId: msg.tabId, trackId: String(msg.trackId), loaded: false, clock: null };
  const mine = current;
  note(`load ${mine.trackId} at ${msg.at}`);
  try {
    await Player.load({ productId: mine.trackId, productType: 'track', sourceId: 'youtubehdx', sourceType: 'PLAYLIST' }, Math.max(0, Number(msg.at) || 0));
    if (current !== mine) return;
    mine.loaded = true;
    note('loaded');
    loop = setInterval(tick, TICK_MS);
    report('loaded');
  } catch (e) {
    note(`load failed: ${e?.message || e}`);
    if (current === mine) report('error', { message: String(e?.message || e) });
  }
}

let previewChecked = false;

async function tick() {
  const c = current;
  if (!c?.loaded || !c.clock) return;
  const k = c.clock;
  const target = k.videoTime + (k.playing ? ((Date.now() - k.sentAt) / 1000) * k.rate : 0) + (k.offset || 0);
  const state = Player.getPlaybackState();
  Player.setVolumeLevel(Math.max(0, Math.min(1, k.volume ?? 1)));

  if (!k.playing || target < 0) {
    if (state === 'PLAYING') Player.pause();
    c.pausedSince ??= Date.now();
    if (!k.playing && Date.now() - c.pausedSince > PARK_MS) park(c);
    return;
  }
  c.pausedSince = null;
  const media = Player.getMediaElement();
  if (state !== 'PLAYING' && state !== 'STALLED') {
    note(`start at ${target.toFixed(2)} (state ${state})`);
    await Player.seek(Math.max(0, target));
    Player.play();
    return;
  }
  if (!previewChecked) {
    previewChecked = true;
    const ctx = Player.getPlaybackContext();
    if (ctx?.actualAssetPresentation === 'PREVIEW') { report('preview', { reason: ctx.previewReason || '' }); stop(false); return; }
    report('playing', { quality: ctx?.actualAudioQuality || null, bitDepth: ctx?.bitDepth || null, sampleRate: ctx?.sampleRate || null });
  }
  if (!media) return;
  const step = yhdxSyncStep(media.currentTime, target, k.rate);
  if (step.seek != null) { note(`jump ${media.currentTime.toFixed(2)} -> ${step.seek.toFixed(2)}`); await Player.seek(step.seek); }
  else if (Math.abs(media.playbackRate - step.rate) > 0.0005) media.playbackRate = step.rate;
}

function park(c) {
  note('parked (long pause)');
  clearInterval(loop);
  loop = null;
  c.loaded = false;
  c.parked = true;
  Player.reset().catch(() => {}).finally(flushPlayLogs);
}

function stop(resetPlayer = true) {
  clearInterval(loop);
  loop = null;
  previewChecked = false;
  current = null;
  if (resetPlayer) Player.reset().catch(() => {}).finally(flushPlayLogs);
}

// The play log is written when playback stops; Chrome closes this page ~30 s after the sound stops, before TIDAL's
// own 30 s timer would send it, so send it right away (the play counts for the artist like any TIDAL play).
function flushPlayLogs() {
  setTimeout(() => {
    EventProducer.flush().then(() => note('play logs sent'), (e) => note(`play logs not sent: ${e?.message || e}`));
  }, 1000);
}

Player.events.addEventListener('streaming-privileges-revoked', () => report('revoked'));
Player.events.addEventListener('playback-state-change', (e) => note(`state ${e.detail?.state}`));
Player.events.addEventListener('error', (e) => note(`player error ${JSON.stringify(e.detail)}`));
Player.events.addEventListener('ended', () => { report('ended'); flushPlayLogs(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.cmd === 'load') load(msg);
  else if (msg.cmd === 'clock' && current && msg.tabId === current.tabId && String(msg.trackId) === current.trackId) {
    if (current.parked && msg.playing) {
      note('playing again after a long pause');
      load({ tabId: msg.tabId, trackId: msg.trackId, at: Number(msg.videoTime) || 0 }); // sets a new `current` at once
    }
    current.clock = { videoTime: Number(msg.videoTime) || 0, playing: !!msg.playing, rate: Number(msg.rate) || 1,
      offset: Number(msg.offset) || 0, volume: msg.volume, sentAt: Number(msg.sentAt) || Date.now() };
  } else if (msg.cmd === 'stop' && (!current || msg.tabId === current.tabId)) stop();
  return false;
});

note('ready');
chrome.runtime.sendMessage({ type: 'tidal-offscreen-ready' }).catch(() => {});
