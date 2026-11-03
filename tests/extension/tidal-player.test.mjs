// TIDAL audio in the Player: node --test tests/extension/tidal-player.test.mjs
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlayer, createYoutubePage, loadDefaults, loadPlayerBackground, runBridge } from './harness.mjs';

const { YHDX_DEFAULTS } = loadDefaults();
const settings = (over = {}) => ({ ...structuredClone(YHDX_DEFAULTS), forceQuality: false, ...over });
const advance = (ms) => { for (let t = 0; t < ms; t += 50) mock.timers.tick(50); };
const TRACK = { id: '77042', title: 'Major Tom (Coming Home)', version: null, seconds: 300, artists: ['Peter Schilling'], mediaTags: ['HIRES_LOSSLESS'] };
const audioMsgs = (page, cmd) => page.posted.filter((m) => m.__yhdx === 'tidal-audio' && (!cmd || m.cmd === cmd));

function watch({ saved, over } = {}) {
  const page = createYoutubePage({ player: new FakePlayer({ tracks: [{ languageCode: 'en', kind: '', vss_id: '.en', displayName: 'English' }] }) });
  if (saved) page.savedPrefs.vid1 = saved;
  page.sendSettings(settings(over));
  advance(600);
  return page;
}

/** Match found, TIDAL loaded and playing. */
function playingTidal(opts) {
  const page = watch(opts);
  page.sendTidalMatch('vid1', TRACK);
  page.sendAudioStatus('loaded', { trackId: TRACK.id });
  page.sendAudioStatus('playing', { trackId: TRACK.id, quality: 'HI_RES_LOSSLESS' });
  return page;
}

describe('TIDAL audio for music videos', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));
  afterEach(() => mock.timers.reset());

  test('asks once per video whether TIDAL has the same recording', () => {
    const page = watch();
    const asks = page.posted.filter((m) => m.__yhdx === 'tidal-match-request');
    assert.equal(asks.length, 1);
    assert.equal(asks[0].videoId, 'vid1');
    assert.equal(asks[0].duration, 300);
    assert.match(asks[0].title, /Major Tom/);
    advance(3000);
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 1);
  });

  test('switched off in settings: never asks', () => {
    const page = watch({ over: { tidalAudio: false } });
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 0);
  });

  test('match: loads TIDAL, mutes YouTube once TIDAL is ready, shows the faded sign bottom-left', () => {
    const page = watch();
    page.sendTidalMatch('vid1', TRACK);
    const load = audioMsgs(page, 'load')[0];
    assert.equal(load.trackId, '77042');
    assert.equal(load.at, 42);
    assert.equal(page.player.video.muted, false);          // not before TIDAL is ready
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    assert.equal(page.player.video.muted, true);
    page.sendAudioStatus('playing', { trackId: TRACK.id, quality: 'HI_RES_LOSSLESS' });
    const sign = page.inPlayer('yhdx-hq')[0];
    assert.equal(sign.textContent, '♪ High-quality audio found · TIDAL Hi-Res');
    advance(100);
    assert.ok(sign.classList.contains('yhdx-show'));        // fades in
    advance(5000);
    assert.ok(!sign.classList.contains('yhdx-show'));       // and out
  });

  test('sends the video clock: time, playing, speed, volume and your offset', () => {
    const page = playingTidal({ saved: { audioOffset: 0.2 } });
    page.player.time = 100;
    page.player.video.playbackRate = 1.25;
    advance(300);
    const c = audioMsgs(page, 'clock').at(-1);
    assert.equal(c.trackId, '77042');
    assert.equal(c.videoTime, 100);
    assert.equal(c.playing, true);
    assert.equal(c.rate, 1.25);
    assert.equal(c.offset, 0.2);
    assert.equal(c.volume, 0.8);
    page.player.video.paused = true;
    page.player.video.fire('pause');                        // right away, not on the next tick
    assert.equal(audioMsgs(page, 'clock').at(-1).playing, false);
  });

  test('ads keep their own sound; the music video is muted again after', () => {
    const page = playingTidal();
    page.player.ad = true;
    advance(300);
    assert.equal(page.player.video.muted, false);
    assert.equal(audioMsgs(page, 'clock').at(-1).playing, false);
    page.player.ad = false;
    advance(300);
    assert.equal(page.player.video.muted, true);
  });

  test('YouTube un-muting the element by itself is undone', () => {
    const page = playingTidal();
    page.player.video.muted = false;
    advance(300);
    assert.equal(page.player.video.muted, true);
  });

  test('⇄ menu: timing nudges, another recording, and YouTube sound for this video (remembered)', () => {
    const page = playingTidal();
    page.syncButton().click();
    assert.ok(page.menu().children.some((c) => c.textContent.startsWith('Audio: TIDAL · Peter Schilling – Major Tom')));
    assert.deepEqual(page.menuItems().filter((x) => /TIDAL|YouTube's sound/.test(x)), [
      'TIDAL sound is late: play it 0.1 s earlier',
      'TIDAL sound is early: play it 0.1 s later',
      'Not the same recording: try another TIDAL track',
      "Use YouTube's sound for this video",
    ]);
    page.chooseMenu('TIDAL sound is late: play it 0.1 s earlier');
    assert.equal(page.savedPrefs.vid1.audioOffset, 0.1);
    page.syncButton().click();
    page.chooseMenu("Use YouTube's sound for this video");
    assert.equal(page.savedPrefs.vid1.audio, 'youtube');
    assert.equal(audioMsgs(page, 'stop').length, 1);
    assert.equal(page.player.video.muted, false);
    assert.equal(page.inPlayer('yhdx-hq').length, 0);

    // Next time this video plays: no TIDAL lookup, and the menu offers TIDAL again.
    const again = watch({ saved: page.savedPrefs.vid1 });
    assert.equal(again.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 0);
    again.syncButton().click();
    assert.ok(again.menuItems().includes("Use TIDAL's sound for this video"));
  });

  test('not the same recording: rejects it and looks again without it', () => {
    const page = playingTidal();
    page.syncButton().click();
    page.chooseMenu('Not the same recording: try another TIDAL track');
    assert.deepEqual([...page.savedPrefs.vid1.rejectedTracks], ['77042']);
    const asks = page.posted.filter((m) => m.__yhdx === 'tidal-match-request');
    assert.equal(asks.length, 2);
    assert.deepEqual([...asks[1].exclude], ['77042']);
    assert.equal(page.player.video.muted, false);
  });

  test('TIDAL only gives previews: back to YouTube sound, and no more tries this session', () => {
    const page = watch();
    page.sendTidalMatch('vid1', TRACK);
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    page.sendAudioStatus('preview', { trackId: TRACK.id });
    assert.equal(page.player.video.muted, false);
    assert.match(page.toastText(), /previews/);
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(1500);
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 1);
  });

  test('another video: TIDAL stops and YouTube sound comes back', () => {
    const page = playingTidal();
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(600);
    assert.equal(audioMsgs(page, 'stop').length, 1);
    assert.equal(page.player.video.muted, false);
  });

  test('not signed in: one hint, YouTube sound stays', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { signedOut: true });
    assert.match(page.toastText(), /sign in to TIDAL/);
    assert.equal(audioMsgs(page, 'load').length, 0);
  });

  test("YouTube's right-click menu gets our entries; picking one closes the menu", () => {
    const page = playingTidal();
    page.rightClick();
    advance(10);
    const labels = page.contextMenu.panel.children.map((c) => c.children[1].textContent);
    assert.deepEqual(labels, ['YoutubeHDx: subtitles and audio…', "YoutubeHDx: use YouTube's sound"]);
    page.contextMenu.panel.children[1].click();
    assert.equal(page.contextMenu.style.display, 'none');
    assert.equal(page.savedPrefs.vid1.audio, 'youtube');
    page.rightClick();
    advance(10);
    assert.deepEqual(page.contextMenu.panel.children.map((c) => c.children[1].textContent),
      ['YoutubeHDx: subtitles and audio…', "YoutubeHDx: use TIDAL's sound"]);
    page.contextMenu.panel.children[0].click();
    assert.ok(page.menu());                                  // opens the ⇄ menu
  });
});

describe('bridge: TIDAL messages', () => {
  test('forwards a match request and hands the answer back', async () => {
    const sent = [];
    const posted = await runBridge({}, { onSend: (m) => sent.push(m), reply: (m) => (m.type === 'tidal-match' ? { track: { id: '1' } } : null) });
    await posted.receive({ __yhdx: 'tidal-match-request', videoId: 'vid1', title: 'A - B', author: 'A', duration: 200, exclude: [5] });
    assert.deepEqual({ ...sent.at(-1), exclude: [...sent.at(-1).exclude] },
      { type: 'tidal-match', videoId: 'vid1', title: 'A - B', author: 'A', duration: 200, exclude: ['5'] });
    const back = posted.find((m) => m.__yhdx === 'tidal-match');
    assert.equal(back.track.id, '1');
  });

  test('passes only known audio commands with clean values', async () => {
    const sent = [];
    const posted = await runBridge({}, { onSend: (m) => sent.push(m) });
    await posted.receive({ __yhdx: 'tidal-audio', cmd: 'clock', trackId: '12x3', videoTime: '5', playing: 1, evil: 'x' });
    await posted.receive({ __yhdx: 'tidal-audio', cmd: 'rm -rf' });
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0] }, { type: 'tidal-audio', cmd: 'clock', trackId: '123', videoTime: 5, playing: true });
  });

  test('relays the TIDAL player status to the page', async () => {
    const posted = await runBridge({});
    await posted.fromServiceWorker({ type: 'tidal-audio-status', status: 'playing', trackId: '9', quality: 'LOSSLESS' });
    const m = posted.find((x) => x.__yhdx === 'tidal-audio-status');
    assert.equal(m.status, 'playing');
    assert.equal(m.quality, 'LOSSLESS');
  });

  test('keeps the audio choices per video, cleaned', async () => {
    const local = {};
    const posted = await runBridge({}, { local });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'vid1abcdefg', prefs: { audio: 'youtube', audioOffset: 0.123, rejectedTracks: ['77', 'x'], junk: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(local['prefs:vid1abcdefg'])), { audio: 'youtube', audioOffset: 0.12, rejectedTracks: ['77'] });
  });
});

describe('service worker: TIDAL', () => {
  const tracksDoc = { data: [{ id: '9', attributes: { title: 'Angels', duration: 'PT4M24S', mediaTags: ['LOSSLESS'] }, relationships: { artists: { data: [{ id: 'r' }] } } }],
                      included: [{ id: 'r', type: 'artists', attributes: { name: 'Robbie Williams' } }] };
  const fetchFn = (calls) => async (url, init) => {
    calls.push(url);
    if (url.includes('searchResults')) return { ok: true, status: 200, json: async () => ({ data: [{ relationships: { tracks: { data: [{ id: '9' }] } } }] }) };
    return { ok: true, status: 200, json: async () => tracksDoc };
  };
  const video = { type: 'tidal-match', videoId: 'vid1abcdefg', title: 'Robbie Williams - Angels', author: 'Robbie Williams', duration: 264.3 };

  test('not signed in: says so', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    const r = await bg.send(video);
    assert.equal(r.track, null);
    assert.equal(r.signedOut, true);
  });

  test('signed in: finds the track and caches the answer per video', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: fetchFn(calls) });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3 };
    assert.equal((await bg.send(video)).track.id, '9');
    const n = calls.length;
    assert.equal((await bg.send(video)).track.id, '9');
    assert.equal(calls.length, n);
  });

  test('audio commands: opens the offscreen player once and forwards to it, for one tab at a time', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 3 }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(bg.offscreen.created.length, 1);
    assert.deepEqual([...bg.offscreen.created[0].reasons], ['AUDIO_PLAYBACK']);
    assert.equal(bg.sentToRuntime.at(-1).target, 'offscreen');
    assert.equal(bg.sentToRuntime.at(-1).tabId, 5);
    await bg.send({ type: 'tidal-audio', cmd: 'clock', trackId: '9' }, { tab: { id: 6 } }); // another tab: ignored
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(bg.sentToRuntime.filter((m) => m.cmd === 'clock').length, 0);
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9' }, { tab: { id: 6 } }); // new tab takes over
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(bg.sentToTabs.at(-1)[0], 5);
    assert.equal(bg.sentToTabs.at(-1)[1].status, 'taken');
  });

  test('gives the offscreen player its credentials', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3, userId: '175' };
    bg.local.tidalClientId = 'cid';
    const c = await bg.send({ type: 'tidal-credentials' });
    assert.equal(c.token, 'tok');
    assert.equal(c.clientId, 'cid');
    assert.ok(c.requestedScopes.includes('playback'));
  });
});
