// Offscreen document: plays the TIDAL track with TIDAL's official web player (@tidal-music/player) and keeps it in
// step with the YouTube video. The YouTube tab sends its clock (video time, playing, speed) a few times a second;
// this page does the rest. Built into ../offscreen.js by tools/build-tidal-player.sh (npm + esbuild).
import * as Player from '@tidal-music/player';

const TICK_MS = 100;
const bus = [];
let current = null;   // {tabId, trackId, loaded, clock: {videoTime, playing, rate, offset, volume, sentAt}}
let loop = null;

const provider = {
  bus: (callback) => { bus.push(callback); },
  getCredentials: async () => {
    const c = await chrome.runtime.sendMessage({ type: 'tidal-credentials' });
    if (!c?.token) throw new Error('Not signed in to TIDAL');
    return c;
  },
};

Player.setCredentialsProvider(provider);
Player.bootstrap({ outputDevices: false, players: [{ itemTypes: ['track'], player: 'shaka' }] });

function report(status, extra = {}) {
  if (!current) return;
  chrome.runtime.sendMessage({ type: 'tidal-audio-status', tabId: current.tabId, trackId: current.trackId, status, ...extra }).catch(() => {});
}

async function load(msg) {
  stop(false);
  current = { tabId: msg.tabId, trackId: String(msg.trackId), loaded: false, clock: null };
  const mine = current;
  try {
    await Player.load({ productId: mine.trackId, productType: 'track', sourceId: 'youtubehdx', sourceType: 'PLAYLIST' }, Math.max(0, Number(msg.at) || 0));
    if (current !== mine) return;
    mine.loaded = true;
    loop = setInterval(tick, TICK_MS);
    report('loaded');
  } catch (e) {
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
    return;
  }
  const media = Player.getMediaElement();
  if (state !== 'PLAYING' && state !== 'STALLED') {
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
  if (step.seek != null) await Player.seek(step.seek);
  else if (Math.abs(media.playbackRate - step.rate) > 0.0005) media.playbackRate = step.rate;
}

function stop(resetPlayer = true) {
  clearInterval(loop);
  loop = null;
  previewChecked = false;
  current = null;
  if (resetPlayer) Player.reset().catch(() => {});
}

Player.events.addEventListener('streaming-privileges-revoked', () => report('revoked'));
Player.events.addEventListener('ended', () => report('ended'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.cmd === 'load') load(msg);
  else if (msg.cmd === 'clock' && current && msg.tabId === current.tabId && String(msg.trackId) === current.trackId) {
    current.clock = { videoTime: Number(msg.videoTime) || 0, playing: !!msg.playing, rate: Number(msg.rate) || 1,
      offset: Number(msg.offset) || 0, volume: msg.volume, sentAt: Number(msg.sentAt) || Date.now() };
  } else if (msg.cmd === 'stop' && (!current || msg.tabId === current.tabId)) stop();
  return false;
});
