// Run: node --test tests/extension/tidal-syncfile.test.mjs
import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlayer, createYoutubePage, loadDefaults, loadPlayerBackground, loadTidal, runBridge } from './harness.mjs';

const T = loadTidal();
const track = (id, title, version, seconds, artists, mediaTags = ['LOSSLESS']) => ({ id, title, version, seconds, artists, mediaTags });

describe('lossless first', () => {
  test('Harvest Moon: the lossless 303 s copy wins over the lossy 305 s one for a 305 s video', () => {
    const v = T.yhdxSongParse('Neil Young - Harvest Moon [Official Music Video]', 'neilyoungchannel');
    const tracks = [track('306285259', 'Harvest Moon', null, 305, ['Neil Young'], []),
                    track('49651283', 'Harvest Moon', null, 303, ['Neil Young'], ['LOSSLESS'])];
    assert.equal(T.yhdxTidalPick(v, 305, tracks).id, '49651283');
  });
  test('among equal quality, the closest length still wins', () => {
    const v = T.yhdxSongParse('Neil Young - Harvest Moon', '');
    const tracks = [track('a', 'Harvest Moon', null, 303, ['Neil Young']), track('b', 'Harvest Moon', null, 304.6, ['Neil Young'])];
    assert.equal(T.yhdxTidalPick(v, 305, tracks).id, 'b');
  });
});

describe('where TIDAL should be', () => {
  test('offset and speed factor', () => {
    const k = { videoTime: 100, playing: true, sentAt: 0, rate: 1, offset: -8, scale: 0.999 };
    assert.ok(Math.abs(T.yhdxSyncTarget(k, 1000) - ((101 * 0.999) - 8)) < 1e-9);
    assert.ok(Math.abs(T.yhdxSyncRate(k) - 0.999) < 1e-12);
  });
  test('no speed factor: as before', () => {
    const k = { videoTime: 50, playing: false, sentAt: 0, rate: 1.25, offset: 2 };
    assert.equal(T.yhdxSyncTarget(k, 5000), 52);
    assert.equal(T.yhdxSyncRate(k), 1.25);
  });
  test('a long intro (California Girls style, 40 s) is fine', () => {
    const k = { videoTime: 60, playing: false, sentAt: 0, rate: 1, offset: -40.5, scale: 1 };
    assert.equal(T.yhdxSyncTarget(k, 0), 19.5);
  });
});

describe('the sync file', () => {
  const file = { format: 1, updated: '2026-11-28T03:00:00Z', videos: {
    n2MtEsrcTTs: { status: 'ok', tidal: 49651283, offset: -7.998, scale: 0.998999, quality: 'LOSSLESS' },
    cutsVideo01: { status: 'keep-youtube', reason: 'cuts' },
    badOffset01: { status: 'ok', tidal: 1, offset: 'x', scale: 1 },
    badScale001: { status: 'ok', tidal: 1, offset: 0, scale: 1.5 },
    noTrack0001: { status: 'ok', offset: 0, scale: 1 },
  } };
  test('an ok entry gives the track, offset, speed and a stamp', () => {
    const e = T.yhdxSyncEntry(file, 'n2MtEsrcTTs');
    assert.deepEqual({ ...e, stamp: undefined }, { status: 'ok', tidal: '49651283', offset: -7.998, scale: 0.998999, stamp: undefined });
    assert.equal(typeof e.stamp, 'string');
    assert.notEqual(e.stamp, T.yhdxSyncEntry({ ...file, videos: { n2MtEsrcTTs: { ...file.videos.n2MtEsrcTTs, offset: -7.9 } } }, 'n2MtEsrcTTs').stamp);
  });
  test('keep-youtube entries', () => {
    assert.deepEqual({ ...T.yhdxSyncEntry(file, 'cutsVideo01') }, { status: 'keep-youtube', reason: 'cuts' });
  });
  test('broken entries, unknown videos and broken files are ignored', () => {
    for (const id of ['badOffset01', 'badScale001', 'noTrack0001', 'notInFile01']) assert.equal(T.yhdxSyncEntry(file, id), null);
    assert.equal(T.yhdxSyncEntry(null, 'n2MtEsrcTTs'), null);
    assert.equal(T.yhdxSyncEntry({ format: 2, videos: file.videos }, 'n2MtEsrcTTs'), null);
  });
});

// ---------------------------------------------------------------- the page, the bridge and the service worker

const { YHDX_DEFAULTS } = loadDefaults();
const advance = (ms) => { for (let t = 0; t < ms; t += 50) mock.timers.tick(50); };
const TRACK = { id: '49651283', title: 'Harvest Moon', version: null, seconds: null, artists: ['Neil Young'] };
const audioMsgs = (page, cmd) => page.posted.filter((m) => m.__yhdx === 'tidal-audio' && (!cmd || m.cmd === cmd));
function watch(saved) {
  const page = createYoutubePage({ player: new FakePlayer({ tracks: [{ languageCode: 'en', kind: '', vss_id: '.en', displayName: 'English' }] }) });
  if (saved) page.savedPrefs.vid1 = saved;
  page.sendSettings({ ...structuredClone(YHDX_DEFAULTS), forceQuality: false });
  advance(600);
  return page;
}
const SYNC = { offset: -8, scale: 0.999, stamp: '49651283:-8:0.999' };

describe('page: the sync file measurement', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));
  afterEach(() => mock.timers.reset());

  test('applied: TIDAL starts at video time x speed + offset, and the clock carries the speed', () => {
    const page = watch();
    page.sendTidalMatch('vid1', TRACK, { sync: SYNC });
    assert.ok(Math.abs(audioMsgs(page, 'load')[0].at - (42 * 0.999 - 8)) < 1e-6);
    assert.equal(page.savedPrefs.vid1.audioOffset, -8);
    assert.equal(page.savedPrefs.vid1.audioScale, 0.999);
    assert.equal(page.savedPrefs.vid1.syncStamp, SYNC.stamp);
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    advance(500);
    assert.equal(audioMsgs(page, 'clock').at(-1).scale, 0.999);
  });

  test('your nudge after the measurement stays; a newer measurement replaces it', () => {
    const page = watch({ audioOffset: -7.5, audioScale: 0.999, syncStamp: SYNC.stamp });
    page.sendTidalMatch('vid1', TRACK, { sync: SYNC });
    assert.ok(Math.abs(audioMsgs(page, 'load')[0].at - (42 * 0.999 - 7.5)) < 1e-6);
    const page2 = watch({ audioOffset: -7.5, audioScale: 0.999, syncStamp: 'older' });
    page2.sendTidalMatch('vid1', TRACK, { sync: SYNC });
    assert.equal(page2.savedPrefs.vid1.audioOffset, -8);
  });

  test("keep YouTube's sound: nothing loads", () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { keepYoutube: true, reason: "sync file: keep YouTube's sound (cuts)" });
    assert.equal(audioMsgs(page, 'load').length, 0);
  });
});

describe('bridge: the sync file fields', () => {
  test('keeps the measured speed and stamp with the video, and hands the measurement to the page', async () => {
    const local = {};
    const posted = await runBridge({}, { local, reply: (m) => (m.type === 'tidal-match' ? { track: { id: '1' }, sync: { offset: -8, scale: 0.999, stamp: 's', evil: 1 } } : null) });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'vid1abcdefg', prefs: { audioOffset: -8, audioScale: 0.999, syncStamp: 's' } });
    assert.deepEqual(JSON.parse(JSON.stringify(local['prefs:vid1abcdefg'])), { audioOffset: -8, audioScale: 0.999, syncStamp: 's' });
    await posted.receive({ __yhdx: 'tidal-match-request', videoId: 'vid1', title: 'A - B', author: 'A', duration: 200 });
    assert.deepEqual({ ...posted.find((m) => m.__yhdx === 'tidal-match').sync }, { offset: -8, scale: 0.999, stamp: 's' });
  });
});

describe('service worker: the sync file', () => {
  const doc = { format: 1, updated: '2026-11-28T03:00:00Z', videos: {
    vid1abcdefg: { status: 'ok', tidal: 49651283, offset: -7.998, scale: 0.998999, tidalTitle: 'Neil Young - Harvest Moon' },
    vid2abcdefg: { status: 'keep-youtube', reason: 'cuts' } } };
  const fetchFn = (calls) => async (url) => {
    calls.push(url);
    if (url.startsWith('https://raw.githubusercontent.com/dougkl/YoutubeHDx/main/sync/tidal-sync.json')) return { ok: true, status: 200, json: async () => doc };
    if (url.includes('trackManifests')) return { ok: true, status: 200, json: async () => ({ data: { attributes: { trackPresentation: 'FULL' } } }) };
    return { ok: true, status: 200, json: async () => ({ data: [], included: [] }) };
  };
  const signedIn = (bg) => { bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3 }; };

  test('a measured video: that track, offset and speed, without searching', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: fetchFn(calls) }); signedIn(bg);
    const r = await bg.send({ type: 'tidal-match', videoId: 'vid1abcdefg', title: 'Neil Young - Harvest Moon', author: 'x', duration: 304 });
    assert.equal(r.track.id, '49651283');
    assert.deepEqual({ ...r.sync }, { offset: -7.998, scale: 0.998999, stamp: '49651283:-7.998:0.998999' });
    assert.ok(!calls.some((u) => u.includes('searchResults')));
  });

  test('keep-youtube: no track, says why', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) }); signedIn(bg);
    const r = await bg.send({ type: 'tidal-match', videoId: 'vid2abcdefg', title: 'A - B', author: 'A', duration: 200 });
    assert.equal(r.track, null);
    assert.equal(r.keepYoutube, true);
  });

  test('a measured track your TIDAL tab could not play: normal matching instead', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: fetchFn(calls) }); signedIn(bg);
    bg.local.tidalUnplayable = { 49651283: Date.now() };
    const r = await bg.send({ type: 'tidal-match', videoId: 'vid1abcdefg', title: 'Neil Young - Harvest Moon', author: 'x', duration: 304 });
    assert.equal(r.sync, undefined);
    assert.ok(calls.some((u) => u.includes('searchResults')));
  });

  test('GitHub unreachable and no saved copy: asked again after a while, not with every song', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: async (url) => { calls.push(url); return { ok: false, status: 503, json: async () => ({}) }; } }); signedIn(bg);
    for (let i = 0; i < 3; i++) await bg.send({ type: 'tidal-match', videoId: 'vid9abcdefg', title: 'A - B', author: 'A', duration: 200 });
    assert.equal(calls.filter((u) => u.includes('raw.githubusercontent.com')).length, 1);
  });
});
