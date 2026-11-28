// TIDAL audio in the Player: node --test tests/extension/tidal-player.test.mjs
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlayer, createYoutubePage, loadDefaults, loadPlayerBackground, loadTidal, runBridge } from './harness.mjs';

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
  advance(1600); // crossfade done
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

  test('match: loads TIDAL, crossfades to it once TIDAL sounds, shows the sign bottom-right and keeps a small one there', () => {
    const page = watch();
    page.sendTidalMatch('vid1', TRACK);
    const load = audioMsgs(page, 'load')[0];
    assert.equal(load.trackId, '77042');
    assert.equal(load.at, 42);
    assert.equal(page.player.video.muted, false);          // not before TIDAL is ready
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    assert.equal(page.player.video.muted, false);          // nor before TIDAL actually sounds (no gap)
    page.sendAudioStatus('playing', { trackId: TRACK.id, quality: 'HI_RES_LOSSLESS' });
    advance(750);                                          // halfway through the crossfade: YouTube still audible, quieter
    assert.equal(page.player.video.muted, false);
    assert.ok(page.player.video.volume > 0.4 && page.player.video.volume < 0.75, String(page.player.video.volume));
    advance(850);
    assert.equal(page.player.video.muted, true);           // faded out: muted, its own volume put back
    assert.equal(page.player.video.volume, 0.8);
    const sign = page.inPlayer('yhdx-hq')[0];
    assert.equal(sign.textContent, '♪ High-quality audio found · TIDAL Hi-Res');
    advance(100);
    assert.ok(sign.classList.contains('yhdx-show'));        // fades in
    advance(5000);
    assert.ok(sign.classList.contains('yhdx-mini'));        // then shrinks to a small faded label…
    assert.equal(sign.textContent, '♪ TIDAL Hi-Res');
    advance(60000);
    assert.equal(page.inPlayer('yhdx-hq')[0], sign);       // …that stays as long as TIDAL's sound plays
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(600);
    assert.equal(page.inPlayer('yhdx-hq').length, 0);      // gone with TIDAL's sound
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

  test('the small label: Hi-Res faintest, Lossless easier to see', () => {
    const hi = playingTidal(); // HI_RES_LOSSLESS
    advance(5000);
    assert.match(hi.inPlayer('yhdx-hq')[0].className, /yhdx-mini.*yhdx-hires/);
    const page = watch();
    page.sendTidalMatch('vid1', TRACK);
    page.sendAudioStatus('playing', { trackId: TRACK.id, quality: 'LOSSLESS' });
    advance(6000);
    const el = page.inPlayer('yhdx-hq')[0];
    assert.equal(el.textContent, '♪ TIDAL Lossless');
    assert.doesNotMatch(el.className, /yhdx-hires/);
  });

  test('YouTube un-muting the element by itself is undone', () => {
    const page = playingTidal();
    page.player.video.muted = false;
    advance(300);
    assert.equal(page.player.video.muted, true);
    // at once when the element says so (no moment of YouTube's sound)
    page.player.video.muted = false;
    page.player.video.fire('volumechange');
    assert.equal(page.player.video.muted, true);
  });

  test('the "♪ TIDAL" label opens the small Sync window: TIDAL only (hear both if you ask), arrows move TIDAL, keep / cancel / YouTube\'s sound', () => {
    const page = playingTidal();
    const states = () => page.posted.filter((m) => m.__yhdx === 'tidal-sync-state');
    page.inPlayer('yhdx-hq')[0].click();
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-sync-open').length, 1);
    assert.equal(audioMsgs(page, 'clock').at(-1).both, false, 'TIDAL only when it opens');
    assert.equal(page.player.video.muted, true);
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'both', on: true }); // "Also hear YouTube's sound" (B)
    assert.equal(audioMsgs(page, 'clock').at(-1).both, true);
    assert.equal(page.player.video.muted, false, 'hear both');
    assert.ok(Math.abs(page.player.video.volume - 0.48) < 0.001);
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'nudge', delta: 0.1 });
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'nudge', delta: 1 });
    assert.equal(page.savedPrefs.vid1.audioOffset, 1.1);
    assert.equal(states().at(-1).offset, 1.1);
    assert.equal(audioMsgs(page, 'clock').at(-1).offset, 1.1);
    page.player.video.fire('volumechange'); // hearing both is not undone as "YouTube un-muting"
    assert.equal(page.player.video.muted, false);
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'done' });
    assert.equal(audioMsgs(page, 'clock').at(-1).both, false);
    assert.equal(page.player.video.muted, true);
    assert.equal(page.player.video.volume, 0.8);
    assert.equal(page.savedPrefs.vid1.audioOffset, 1.1, 'kept');
    // cancel puts back what you had when it opened
    page.inPlayer('yhdx-hq')[0].click();
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'nudge', delta: -1 });
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'cancel' });
    assert.equal(page.savedPrefs.vid1.audioOffset, 1.1);
    // YouTube's sound from the window
    page.inPlayer('yhdx-hq')[0].click();
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'youtube' });
    assert.equal(page.savedPrefs.vid1.audio, 'youtube');
    assert.equal(audioMsgs(page, 'stop').length, 1);
    advance(800);
    assert.equal(page.player.video.muted, false);
  });

  test('the Sync window closes when the video changes', () => {
    const page = playingTidal();
    page.inPlayer('yhdx-hq')[0].click();
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(600);
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-sync-state').at(-1).closed, true);
  });

  test('commands from a Sync window that is not open for this video are ignored', () => {
    const page = playingTidal();
    page.fireMessage({ __yhdx: 'tidal-sync', cmd: 'nudge', delta: 1 });
    assert.equal(page.savedPrefs.vid1?.audioOffset ?? 0, 0);
  });

  test('⇄ menu: timing nudges, another recording, and YouTube sound for this video (remembered)', () => {
    const page = playingTidal();
    page.syncButton().click();
    assert.ok(page.menu().children.some((c) => c.textContent.startsWith('Audio: TIDAL · Peter Schilling – Major Tom')));
    assert.deepEqual(page.menuItems().filter((x) => /TIDAL|YouTube's sound/.test(x)), [
      'Sync TIDAL in a small window (arrow keys; drag it to another screen)',
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

  test('song with only a TIDAL preview: keeps YouTube sound quietly, the next song still tries TIDAL', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { preview: true, reason: 'TIDAL has only a 30-second preview of this song' });
    assert.equal(audioMsgs(page, 'load').length, 0);
    assert.equal(page.player.video.muted, false);
    assert.equal(page.toastText(), undefined);
    const note = page.inPlayer('yhdx-hq')[0];                // says in the corner that TIDAL was tried, and why not
    assert.equal(note.textContent, "♪ TIDAL: only a 30-second preview of this song · YouTube's sound");
    advance(8000);
    const mini = page.inPlayer('yhdx-hq');                   // then a small "♪ YouTube" stays in the corner
    assert.equal(mini.length, 1);
    assert.equal(mini[0].textContent, '♪ YouTube');
    assert.match(mini[0].className, /yhdx-mini/);
    mini[0].click();                                          // which opens the ⇄ menu
    assert.ok(page.menu());
    page.syncButton().click();
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(1500);
    assert.equal(page.inPlayer('yhdx-yt').length, 0, "the last video's label goes");
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 2);
    page.sendTidalMatch('vid2', TRACK);
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    page.sendAudioStatus('playing', { trackId: TRACK.id, quality: 'LOSSLESS' });
    advance(1600);
    assert.equal(page.player.video.muted, true);
    assert.equal(page.inPlayer('yhdx-hq').length, 1);
  });

  test('TIDAL turns out to give only a preview while loading: back to YouTube sound for that song only', () => {
    const page = watch();
    page.sendTidalMatch('vid1', TRACK);
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    page.sendAudioStatus('preview', { trackId: TRACK.id });
    assert.equal(page.player.video.muted, false);
    assert.equal(page.toastText(), undefined);
    assert.match(page.inPlayer('yhdx-hq')[0].textContent, /only a 30-second preview/);
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(1500);
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 2);
  });

  test('no same-length recording on TIDAL: says so in the corner once', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL' });
    assert.equal(page.inPlayer('yhdx-hq')[0].textContent, "♪ TIDAL: no same-length recording · YouTube's sound");
    assert.equal(page.player.video.muted, false);
  });

  test('TIDAL\'s version a few seconds off: "Use TIDAL anyway" in the ⇄ menu, then sync it by hand or keep YouTube\'s sound', () => {
    const page = watch();
    const nearest = { id: '55', title: 'Major Tom', version: null, artists: ['Peter Schilling'], seconds: 306 };
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL', nearest });
    assert.equal(audioMsgs(page, 'load').length, 0, 'not by itself');
    page.syncButton().click();
    assert.deepEqual(page.menuItems().filter((x) => /anyway/.test(x)), [
      'Use TIDAL anyway: TIDAL has a longer intro (skips its first 6 s) · TIDAL 5:06, video 5:00',
      'Use TIDAL anyway: TIDAL has a longer ending · TIDAL 5:06, video 5:00',
    ]);
    page.chooseMenu('Use TIDAL anyway: TIDAL has a longer ending · TIDAL 5:06, video 5:00');
    assert.equal(page.savedPrefs.vid1.audio, 'tidal');
    assert.equal(page.savedPrefs.vid1.audioOffset, 0);
    const asks = page.posted.filter((m) => m.__yhdx === 'tidal-match-request');
    assert.equal(asks.length, 2);
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL', nearest });
    assert.equal(audioMsgs(page, 'load').at(-1).trackId, '55');
    assert.equal(audioMsgs(page, 'load').at(-1).via, 'web');
    page.sendAudioStatus('loaded', { trackId: '55' });
    page.sendAudioStatus('playing', { trackId: '55' });
    advance(1600);
    assert.equal(page.player.video.muted, true);
    page.syncButton().click();
    const items = page.menuItems();
    assert.ok(items.includes('TIDAL sound is late: play it 1 s earlier'));
    assert.ok(items.includes('TIDAL sound is early: play it 1 s later'));
    assert.ok(!items.includes('Not the same recording: try another TIDAL track'));
    page.chooseMenu('TIDAL sound is late: play it 1 s earlier');
    assert.equal(page.savedPrefs.vid1.audioOffset, 1);
    assert.equal(audioMsgs(page, 'clock').at(-1).offset, 1);
    page.syncButton().click();
    page.chooseMenu("Keep YouTube's sound for this video (as before)");
    assert.equal(page.savedPrefs.vid1.audio, 'youtube');
    assert.equal(audioMsgs(page, 'stop').length, 1);
    advance(800);
    assert.equal(page.player.video.muted, false);
  });

  test('TIDAL shorter, the video has a longer intro: TIDAL starts later; YouTube\'s sound where TIDAL has nothing', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL', nearest: { id: '55', title: 'Major Tom', artists: ['Peter Schilling'], seconds: 293 } });
    page.syncButton().click();
    page.chooseMenu('Use TIDAL anyway: the video has a longer intro (TIDAL starts at 0:07) · TIDAL 4:53, video 5:00');
    assert.equal(page.savedPrefs.vid1.audioOffset, -7);
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL', nearest: { id: '55', title: 'Major Tom', artists: ['Peter Schilling'], seconds: 293 } });
    assert.equal(audioMsgs(page, 'clock').at(-1).offset, -7);
    page.sendAudioStatus('playing', { trackId: '55' });
    advance(1600);
    assert.equal(page.player.video.muted, true);
    // the video's ending goes on after TIDAL's song: YouTube's sound comes back, no silence
    page.sendAudioStatus('gap', { trackId: '55' });
    advance(800);
    assert.equal(page.player.video.muted, false);
    assert.equal(page.player.video.volume, 0.8);
    // you go back: TIDAL plays again, YouTube fades out again
    page.sendAudioStatus('playing', { trackId: '55' });
    advance(1600);
    assert.equal(page.player.video.muted, true);
    assert.equal(page.inPlayer('yhdx-hq').length, 1);
  });

  test('TIDAL\'s closest version 10-20 s off: the ⇄ menu asks first, then offers it', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL', nearest: { id: '56', title: 'Major Tom', artists: ['Peter Schilling'], seconds: 285 } });
    assert.match(page.inPlayer('yhdx-hq')[0].textContent, /its version is 15 s shorter · ⇄ to use it anyway/);
    page.syncButton().click();
    assert.ok(!page.menuItems().some((x) => /anyway/.test(x)));
    page.chooseMenu("No TIDAL version within 10 s: try TIDAL's, 15 s shorter? · TIDAL 4:45, video 5:00");
    assert.ok(page.menu(), 'the menu opens again');
    assert.ok(page.menuItems().includes('Use TIDAL anyway: the video has a longer intro (TIDAL starts at 0:15) · TIDAL 4:45, video 5:00'));
  });

  test('TIDAL\'s version too far off (no closest one offered): no "Use TIDAL anyway"', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'no same-length recording on TIDAL' });
    page.syncButton().click(); // (it shows for the subtitles here)
    assert.ok(!page.menuItems().some((x) => /TIDAL anyway/.test(x)));
  });

  test('"Use the song in my TIDAL tab": takes it where it is (your sync), remembered for this video', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'song not found on TIDAL' });
    page.syncButton().click();
    page.chooseMenu('Use the song in my TIDAL tab for this video (keeps your sync)');
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-pick-request').length, 1);
    // your TIDAL tab plays it 3.5 s ahead of the video (the video is at 42 s)
    page.fireMessage({ __yhdx: 'tidal-pick', track: { id: '777', title: 'Major Tom (Völlig Losgelöst)', artist: 'Peter Schilling', seconds: 300,
      at: 45.5, playing: true, sentAt: Date.now() } });
    const saved = page.savedPrefs.vid1;
    assert.equal(JSON.stringify(saved.pickedTrack), JSON.stringify({ id: '777', title: 'Major Tom (Völlig Losgelöst)', artist: 'Peter Schilling', seconds: 300 }));
    assert.equal(saved.audioOffset, 3.5);
    assert.match(page.toastText(), /TIDAL for this video: Peter Schilling – Major Tom/);
    // the Player asks again and plays your song, whatever TIDAL's search says
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length, 2);
    page.sendTidalMatch('vid1', { id: '999', title: 'Major Tom', artists: ['Peter Schilling'] });
    const load = audioMsgs(page, 'load').at(-1);
    assert.equal(load.trackId, '777');
    assert.equal(load.via, 'web');
    assert.equal(audioMsgs(page, 'clock').at(-1).offset, 3.5);
    page.sendAudioStatus('playing', { trackId: '777' });
    advance(1600);
    page.syncButton().click();
    assert.ok(page.menuItems().includes("Keep YouTube's sound for this video (as before)"));
  });

  test('"Use the song in my TIDAL tab" with nothing there: says so', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'song not found on TIDAL' });
    page.syncButton().click();
    page.chooseMenu('Use the song in my TIDAL tab for this video (keeps your sync)');
    page.fireMessage({ __yhdx: 'tidal-pick', track: null });
    assert.match(page.toastText(), /Play the song in your TIDAL tab first/);
    assert.equal(page.savedPrefs.vid1?.pickedTrack, undefined);
  });

  test('TIDAL says the song is unavailable: YouTube\'s sound, your choice naming it dropped, one more look for another version', () => {
    const page = watch();
    page.sendTidalMatch('vid1', null, { reason: 'song not found on TIDAL' });
    page.syncButton().click();
    page.chooseMenu('Use the song in my TIDAL tab for this video (keeps your sync)');
    page.fireMessage({ __yhdx: 'tidal-pick', track: { id: '777', title: 'I Try', artist: 'Macy Gray', seconds: 239, at: 40, playing: true, sentAt: Date.now() } });
    page.sendTidalMatch('vid1', null, { reason: 'song not found on TIDAL' });
    assert.equal(audioMsgs(page, 'load').at(-1).trackId, '777');
    const asks = () => page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length;
    const before = asks();
    page.sendAudioStatus('unavailable', { trackId: '777' });
    assert.equal(page.savedPrefs.vid1.pickedTrack, undefined, 'your pick is dropped');
    assert.equal(audioMsgs(page, 'stop').length, 1);
    assert.match(page.inPlayer('yhdx-hq')[0].textContent, /can't play this version/);
    advance(1600);
    assert.equal(asks(), before + 1, 'looks once more');
    assert.equal(page.player.video.muted, false);
    page.sendAudioStatus('unavailable', { trackId: '778' });
    advance(1600);
    assert.equal(asks(), before + 1, 'only once');
  });

  test('page left over from before an update: tells you to reload it', () => {
    const page = watch();
    page.fireMessage({ __yhdx: 'stale' });
    assert.match(page.toastText(), /reload this page/);
  });

  test('page left over from before an update while TIDAL played: YouTube\'s sound comes back', () => {
    const page = playingTidal();
    assert.equal(page.player.video.muted, true);
    page.fireMessage({ __yhdx: 'stale' });
    advance(800);
    assert.equal(page.player.video.muted, false);
    assert.equal(page.player.video.volume, 0.8);
    assert.equal(page.inPlayer('yhdx-hq').length, 0);
  });

  test('TIDAL couldn\'t start by itself: a short note (never left over the video), "open the TIDAL tab" in the ⇄ menu', () => {
    const page = watch();
    page.sendTidalMatch('vid1', TRACK);
    page.sendAudioStatus('need-click', { trackId: TRACK.id });
    const note = page.inPlayer('yhdx-click')[0];
    assert.match(note.textContent, /didn't start by itself/);
    note.click();
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-focus').length, 1);
    advance(8000);
    assert.equal(page.inPlayer('yhdx-click').length, 0, 'gone after a few seconds');
    assert.equal(page.player.video.muted, false, "YouTube's sound until then");
    page.syncButton().click();
    page.chooseMenu("TIDAL didn't start: open the TIDAL tab (press Play there)");
    assert.equal(page.posted.filter((m) => m.__yhdx === 'tidal-focus').length, 2);
    page.sendAudioStatus('loaded', { trackId: TRACK.id });
    assert.equal(page.inPlayer('yhdx-click').length, 0);
    page.sendAudioStatus('playing', { trackId: TRACK.id });
    advance(1600);
    assert.equal(page.player.video.muted, true);
  });

  test('back to YouTube\'s sound (another video, your choice, an error): it fades back in, no jump', () => {
    const page = playingTidal();
    assert.equal(page.player.video.muted, true);
    page.syncButton().click();
    page.chooseMenu("Use YouTube's sound for this video");
    advance(60);
    assert.equal(page.player.video.muted, false);
    assert.ok(page.player.video.volume < 0.3, `starts quiet: ${page.player.video.volume}`);
    advance(800);
    assert.equal(page.player.video.volume, 0.8);
  });

  test('the video ends: TIDAL stops (so it can\'t go on to other songs); playing it again asks TIDAL again', () => {
    const page = playingTidal();
    page.player.video.fire('ended');
    assert.equal(audioMsgs(page, 'stop').length, 1);
    advance(800);
    assert.equal(page.player.video.muted, false);
    assert.equal(page.inPlayer('yhdx-hq').length, 0);
    const asks = () => page.posted.filter((m) => m.__yhdx === 'tidal-match-request').length;
    const before = asks();
    page.player.video.fire('play');
    advance(600);
    assert.equal(asks(), before + 1);
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

  test('after the Player is updated while YouTube is open: no errors, says once to reload the page', async () => {
    const posted = await runBridge({});
    posted.invalidate();
    const before = posted.length;
    await posted.receive({ __yhdx: 'prefs-request', videoId: 'vid1abcdefg' });
    await posted.receive({ __yhdx: 'tidal-match-request', videoId: 'vid1abcdefg', title: 'A - B', author: 'A', duration: 200 });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'vid1abcdefg', prefs: { audio: 'youtube' } });
    // the video's clock (4 times a second) and the corner note's click must not throw either
    for (let i = 0; i < 5; i++) await posted.receive({ __yhdx: 'tidal-audio', cmd: 'clock', trackId: '9', videoTime: i, playing: true });
    await posted.receive({ __yhdx: 'tidal-focus' });
    await posted.receive({ __yhdx: 'ready' });
    const after = posted.slice(before);
    assert.equal(after.filter((m) => m.__yhdx === 'stale').length, 1);
  });

  test('Sync window messages: commands into the page, the page\'s state out, "hear both" in the clock', async () => {
    const out = [];
    const posted = await runBridge({}, { onSend: (msg) => out.push(msg) });
    await posted.fromServiceWorker({ type: 'tidal-sync', cmd: 'nudge', delta: -0.1, on: false });
    const m = posted.find((x) => x.__yhdx === 'tidal-sync');
    assert.equal(JSON.stringify([m.cmd, m.delta]), JSON.stringify(['nudge', -0.1]));
    await posted.receive({ __yhdx: 'tidal-sync-state', title: 'A - B', offset: 1.5, both: true, status: 'on', closed: false, junk: 1 });
    await posted.receive({ __yhdx: 'tidal-sync-open' });
    await posted.receive({ __yhdx: 'tidal-audio', cmd: 'clock', trackId: '9', videoTime: 1, playing: true, both: true });
    assert.ok(out.some((x) => x.type === 'tidal-sync-state' && x.offset === 1.5 && x.both === true && !('junk' in x)));
    assert.ok(out.some((x) => x.type === 'tidal-sync-open'));
    assert.ok(out.some((x) => x.type === 'tidal-audio' && x.cmd === 'clock' && x.both === true));
  });

  test('keeps the audio choices per video, cleaned', async () => {
    const local = {};
    const posted = await runBridge({}, { local });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'vid1abcdefg', prefs: { audio: 'youtube', audioOffset: 0.123, rejectedTracks: ['77', 'x'], junk: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(local['prefs:vid1abcdefg'])), { audio: 'youtube', audioOffset: 0.12, rejectedTracks: ['77'] });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'vid1abcdefg', prefs: { audio: 'tidal', audioOffset: -12.5 } });
    assert.deepEqual(JSON.parse(JSON.stringify(local['prefs:vid1abcdefg'])), { audio: 'tidal', audioOffset: -12.5 });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'vid1abcdefg', prefs: { audio: 'other' } });
    assert.equal(local['prefs:vid1abcdefg'], undefined);
  });
});

describe('service worker: TIDAL', () => {
  const tracksDoc = { data: [{ id: '9', attributes: { title: 'Angels', duration: 'PT4M24S', mediaTags: ['LOSSLESS'] }, relationships: { artists: { data: [{ id: 'r' }] } } }],
                      included: [{ id: 'r', type: 'artists', attributes: { name: 'Robbie Williams' } }] };
  const fetchFn = (calls) => async (url, init) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return { ok: false, status: 404, json: async () => ({}) }; // no sync file here
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

  test('TIDAL\'s search: a track without STREAM in its availability is marked unplayable', async () => {
    const T2 = loadTidal();
    const fetchFn2 = async (url) => {
      if (url.includes('searchResults')) return { ok: true, status: 200, json: async () => ({ data: [{ relationships: { tracks: { data: [{ id: '1' }, { id: '2' }] } } }] }) };
      return { ok: true, status: 200, json: async () => ({ data: [
        { id: '1', attributes: { title: 'I Try', duration: 'PT3M56S', availability: ['DJ'] }, relationships: { artists: { data: [{ id: 'a' }] } } },
        { id: '2', attributes: { title: 'I Try', duration: 'PT3M57S', availability: ['STREAM', 'DJ'] }, relationships: { artists: { data: [{ id: 'a' }] } } }],
        included: [{ id: 'a', type: 'artists', attributes: { name: 'Macy Gray' } }] }) };
    };
    const tracks = await T2.yhdxTidalSearch('macy gray i try', { fetchFn: fetchFn2, token: 't' });
    assert.equal(JSON.stringify(tracks.map((t) => [t.id, t.streamable])), JSON.stringify([['1', false], ['2', true]]));
  });

  test('your TIDAL tab says a track is unavailable: never picked again, a remembered match to it is looked up anew', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: fetchFn(calls) });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3 };
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 0, via: 'web', title: 'Robbie Williams - Angels' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    const web = bg.tabs.created[0].id;
    bg.local['tidal:vid1abcdefg'] = { at: Date.now(), ttl: 30 * 24 * 3600e3, rules: 4, result: { track: { id: '9', title: 'Angels' } } };
    await bg.send({ type: 'tidal-web-status', status: 'unavailable', trackId: '9', detail: 'TIDAL says: Sorry, this content is currently unavailable. (NPBI0)' }, { tab: { id: web } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bg.local.tidalUnplayable['9']);
    assert.ok(bg.sentToTabs.some(([id, m]) => id === 5 && m.status === 'unavailable'), 'the video is told');
    assert.ok(bg.local.tidalLog.some((e) => e.outcome === 'unavailable' && /NPBI0/.test(e.detail) && e.video === 'Robbie Williams - Angels'));
    const n = calls.length;
    const r = await bg.send(video);
    assert.ok(calls.length > n, 'looked up again, not the remembered answer');
    assert.equal(r.track, null, 'the only same-length version is the unplayable one');
    assert.ok(calls.some((u) => u.includes('/tracks?')));
  });

  test('a "not on TIDAL" answer from before the matching rules changed is asked again; a current one is kept', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: fetchFn(calls) });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3 };
    bg.local['tidal:vid1abcdefg'] = { at: Date.now(), ttl: 7 * 24 * 3600e3, result: { track: null, reason: 'no same-length recording on TIDAL' } };
    assert.equal((await bg.send(video)).track.id, '9');
    assert.ok(calls.length > 0);
    bg.local['tidal:vid1abcdefg'] = { at: Date.now(), ttl: 7 * 24 * 3600e3, rules: 4, result: { track: null, reason: 'song not found on TIDAL' } };
    const n = calls.length;
    assert.equal((await bg.send(video)).track, null);
    assert.equal(calls.length, n);
  });

  test('audio commands: opens the offscreen player once and forwards to it, for one tab at a time', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 3 }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20)); // the offscreen page says "ready" before commands go to it
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

  test('after a long pause (Chrome closed the TIDAL page) playing again reopens it where the video is', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 3 }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    bg.offscreen.open = false; // closed by Chrome while paused
    const before = bg.sentToRuntime.length;
    await bg.send({ type: 'tidal-audio', cmd: 'clock', trackId: '9', videoTime: 95.5, playing: false }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bg.offscreen.created.length, 1, 'still paused: nothing to play yet');
    await bg.send({ type: 'tidal-audio', cmd: 'clock', trackId: '9', videoTime: 96, playing: true }, { tab: { id: 5 } });
    await bg.send({ type: 'tidal-audio', cmd: 'clock', trackId: '9', videoTime: 96.25, playing: true }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bg.offscreen.created.length, 2);
    const sent = bg.sentToRuntime.slice(before);
    const loads = sent.filter((m) => m.cmd === 'load');
    assert.equal(loads.length, 1);
    assert.equal(loads[0].trackId, '9');
    assert.equal(loads[0].at, 96);
    assert.equal(loads[0].target, 'offscreen');
    assert.ok(sent.filter((m) => m.cmd === 'clock').length >= 1, 'the clock follows the load');
  });

  test('remembers the playing tab when Chrome restarts the idle service worker', async () => {
    const first = loadPlayerBackground({ fetchFn: fetchFn([]) });
    await first.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 3 }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    const restarted = loadPlayerBackground({ fetchFn: fetchFn([]), session: first.session });
    restarted.offscreen.open = true;
    await restarted.send({ type: 'tidal-audio', cmd: 'clock', trackId: '9', videoTime: 10, playing: true }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(restarted.sentToRuntime.filter((m) => m.cmd === 'clock' && m.tabId === 5).length, 1);
  });

  test('asks TIDAL whether the song plays in full; preview-only for the app: one other recording, else your TIDAL web player', async () => {
    const twoTracks = { data: [
      { id: '9', attributes: { title: 'Angels', duration: 'PT4M24S' }, relationships: { artists: { data: [{ id: 'r' }] } } },
      { id: '10', attributes: { title: 'Angels', duration: 'PT4M25S' }, relationships: { artists: { data: [{ id: 'r' }] } } }],
      included: [{ id: 'r', type: 'artists', attributes: { name: 'Robbie Williams' } }] };
    const run = async (presentations) => {
      const calls = [];
      const bg = loadPlayerBackground({ fetchFn: async (url) => {
        calls.push(url);
        if (url.includes('searchResults')) return { ok: true, status: 200, json: async () => ({ data: [{ relationships: { tracks: { data: [{ id: '9' }, { id: '10' }] } } }] }) };
        const m = /trackManifests\/(\d+)/.exec(url);
        if (m) return { ok: true, status: 200, json: async () => ({ data: { attributes: { trackPresentation: presentations[m[1]] } } }) };
        return { ok: true, status: 200, json: async () => twoTracks };
      } });
      bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3, userId: '175' };
      return { bg, calls, r: await bg.send(video) };
    };
    const full = await run({ 9: 'FULL', 10: 'FULL' });
    assert.equal(full.r.track.id, '9');
    assert.match(full.calls.find((u) => u.includes('trackManifests')), /trackManifests\/9\?.*usage=PLAYBACK/);

    const other = await run({ 9: 'PREVIEW', 10: 'FULL' });
    assert.equal(other.r.track.id, '10', 'the other same-length recording plays in full');

    const none = await run({ 9: 'PREVIEW', 10: 'PREVIEW' });
    assert.equal(none.r.track.id, '9', 'previews only for the app: your TIDAL web player plays it');
    assert.equal(none.r.via, 'web');
    assert.equal(none.r.preview, true);
    const saved = none.bg.local['tidal:vid1abcdefg'];
    assert.equal(saved.ttl, 30 * 24 * 3600e3);
    const before = none.calls.length;
    assert.equal((await none.bg.send(video)).via, 'web');
    assert.equal(none.calls.length, before, 'remembered: no new questions to TIDAL for this song');
    saved.at -= 31 * 24 * 3600e3;
    await none.bg.send(video);
    assert.ok(none.calls.length > before, 'asked again after 30 days');
  });

  test('keeps a log of what happened per song, for the settings page only', async () => {
    const calls = [];
    const bg = loadPlayerBackground({ fetchFn: fetchFn(calls) });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3, userId: '175' };
    await bg.send(video);                                  // found (manifest answer unknown here: treated as playable)
    await bg.send(video);                                  // remembered
    await bg.send({ type: 'tidal-audio-status', status: 'playing', tabId: 5, trackId: '9', quality: 'LOSSLESS' });
    await new Promise((r) => setTimeout(r, 20));
    const fromYoutube = await bg.send({ type: 'tidal-log' }, { url: 'https://www.youtube.com/watch?v=x', tab: { id: 5 } });
    assert.equal(fromYoutube, undefined, 'YouTube pages cannot read it');
    const log = await bg.send({ type: 'tidal-log' }, { url: 'chrome-extension://test/options.html' });
    assert.equal(log.length, 3);
    assert.equal(log[2].outcome, 'found, playing TIDAL');
    assert.match(log[2].track, /Robbie Williams – Angels \[9\]/);
    assert.match(log[1].detail, /remembered/);
    assert.equal(log[0].step, 'player');
    assert.equal(log[0].outcome, 'playing');
    assert.equal(log[0].video, 'Robbie Williams - Angels');
    await bg.send({ type: 'tidal-log-clear' }, { url: 'chrome-extension://test/options.html' });
    assert.equal(bg.local.tidalLog, undefined);
  });

  test('"Use the song in my TIDAL tab": the song in your TIDAL tab\'s player bar, and where it is', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.tabs.open.push({ id: 70, url: 'https://tidal.com/search?q=x', windowId: 1 });
    const r0 = await bg.send({ type: 'tidal-pick', title: 'Peter Schilling - Major Tom' }, { tab: { id: 5 } });
    assert.equal(r0, null, 'nothing in its player bar');
    bg.tabs.answer[70] = (m) => (m.cmd === 'which' ? { id: '777', title: 'Major Tom', artist: 'Peter Schilling', seconds: 300, at: 12, playing: true, sentAt: 1 } : undefined);
    const r = await bg.send({ type: 'tidal-pick', title: 'Peter Schilling - Major Tom' }, { tab: { id: 5 } });
    assert.equal(r.id, '777');
    assert.equal(bg.session.tidalWebTab, 70, 'that tab is the TIDAL tab now');
    await new Promise((res) => setTimeout(res, 20));
    assert.match(bg.local.tidalLog[0].outcome, /you chose the song in your TIDAL tab/);
    assert.equal(bg.local.tidalLog[0].video, 'Peter Schilling - Major Tom');
  });

  test('the Sync window: a small popup, where you left it last time, one at a time; it talks to the video\'s tab only', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    const tick = () => new Promise((r) => setTimeout(r, 20));
    await bg.send({ type: 'tidal-sync-open' }, { tab: { id: 5 } });
    await tick();
    assert.equal(bg.tabs.windows.length, 1);
    assert.equal(bg.tabs.windows[0].type, 'popup');
    assert.equal(bg.tabs.windows[0].url, 'chrome-extension://test/sync.html?tab=5');
    assert.equal(bg.tabs.windows[0].left, undefined);
    bg.local.syncWindowBounds = { left: -1500, top: 200, width: 420, height: 310 }; // on your other screen
    await bg.send({ type: 'tidal-sync-open' }, { tab: { id: 5 } });
    await tick();
    assert.deepEqual([...bg.tabs.windowsClosed], [500], 'the old one closes');
    assert.equal(JSON.stringify([bg.tabs.windows[1].left, bg.tabs.windows[1].top, bg.tabs.windows[1].width]), '[-1500,200,420]');
    // that screen is gone: opens where Chrome likes
    bg.tabs.refusePlace = true;
    await bg.send({ type: 'tidal-sync-open' }, { tab: { id: 5 } });
    await tick();
    assert.equal(bg.tabs.windows.length, 3);
    assert.equal(bg.tabs.windows[2].left, undefined);
    // commands: from the window (an extension page) to the video's tab; from anywhere else, nothing
    const ok = await bg.send({ type: 'tidal-sync', tabId: 5, cmd: 'nudge', delta: 0.1 }, { url: 'chrome-extension://test/sync.html?tab=5' });
    assert.equal(ok, true);
    assert.equal(JSON.stringify(bg.sentToTabs.at(-1)), JSON.stringify([5, { type: 'tidal-sync', cmd: 'nudge', delta: 0.1, on: false }]));
    const n = bg.sentToTabs.length;
    await bg.send({ type: 'tidal-sync', tabId: 5, cmd: 'nudge', delta: 5 }, { tab: { id: 9 }, url: 'https://evil.example/' });
    assert.equal(bg.sentToTabs.length, n);
  });

  test('your TIDAL tab: opened pinned in the background, gets the song once it says hello, then the clock; answers go to the video', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    const tick = () => new Promise((r) => setTimeout(r, 10));
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '11009839', at: 12, via: 'web' }, { tab: { id: 5 } });
    await tick();
    assert.equal(bg.tabs.created.length, 1);
    assert.deepEqual({ url: bg.tabs.created[0].url, active: bg.tabs.created[0].active, pinned: bg.tabs.created[0].pinned },
                     { url: 'https://tidal.com/track/11009839', active: false, pinned: true });
    assert.equal(bg.offscreen.created.length, 0, 'not the restricted app player');
    const web = bg.tabs.created[0].id;
    await bg.send({ type: 'tidal-web-hello' }, { tab: { id: web, url: 'https://tidal.com/track/11009839' } });
    await tick();
    const toWeb = () => bg.sentToTabs.filter(([id]) => id === web).map(([, m]) => m);
    assert.equal(toWeb().filter((m) => m.cmd === 'load').at(-1).trackId, '11009839');
    await bg.send({ type: 'tidal-audio', cmd: 'clock', trackId: '11009839', videoTime: 13, playing: true }, { tab: { id: 5 } });
    await tick();
    assert.equal(toWeb().at(-1).cmd, 'clock');
    assert.equal(toWeb().at(-1).target, 'tidal-web');
    await bg.send({ type: 'tidal-web-status', status: 'playing', trackId: '11009839', quality: 'LOSSLESS' }, { tab: { id: web } });
    await tick();
    const back = bg.sentToTabs.filter(([id]) => id === 5).at(-1)[1];
    assert.deepEqual({ type: back.type, status: back.status, quality: back.quality }, { type: 'tidal-audio-status', status: 'playing', quality: 'LOSSLESS' });
    // next song: same tab, no new one
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '54287688', at: 0, via: 'web' }, { tab: { id: 5 } });
    await tick();
    assert.equal(bg.tabs.created.length, 1);
    assert.equal(toWeb().at(-1).trackId, '54287688');
    // you close the TIDAL tab: the video goes back to its own sound
    await bg.closeTab(web);
    await tick();
    assert.equal(bg.sentToTabs.filter(([id]) => id === 5).at(-1)[1].status, 'error');
  });

  test('the song is over: the TIDAL tab stays open (paused) and plays the next song, even much later', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
      const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '1', at: 0, via: 'web' }, { tab: { id: 5 } });
      await flush();
      const web = bg.tabs.created[0].id;
      await bg.send({ type: 'tidal-audio', cmd: 'stop' }, { tab: { id: 5 } });
      await flush();
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === web && m.cmd === 'stop').length, 1);
      mock.timers.tick(30 * 60e3);
      await flush();
      assert.deepEqual(bg.tabs.closed, []);
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
      await flush();
      assert.equal(bg.tabs.created.length, 1);
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === web && m.cmd === 'load').at(-1)[1].trackId, '2');
    } finally {
      mock.timers.reset();
    }
  });

  test('a new TIDAL tab (Chrome holds its sound until it has been shown): shown for a moment, then back to the video', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
      const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
      bg.tabs.open.push({ id: 5, url: 'https://www.youtube.com/watch?v=x', windowId: 1, active: true });
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '1', at: 0, via: 'web' }, { tab: { id: 5 } });
      await flush();
      const web = bg.tabs.created[0].id;
      bg.tabs.created[0].windowId = 1;
      bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '1' }, { tab: { id: web }, url: 'https://tidal.com/track/1' });
      await flush();
      // shown first, Play pressed while it's in front (pressing it while hidden is what failed)
      assert.equal(JSON.stringify(bg.tabs.updated), JSON.stringify([[web, { active: true }]]));
      assert.equal(bg.dbg.log.filter(([m]) => m === 'Runtime.evaluate').length, 0);
      mock.timers.tick(1000); // a moment to start by itself first
      await flush();
      assert.equal(bg.dbg.log.filter(([m, id]) => m === 'Runtime.evaluate' && id === web).length, 1);
      await bg.send({ type: 'tidal-web-status', status: 'loaded', trackId: '1' }, { tab: { id: web } });
      await flush();
      mock.timers.tick(800);
      await flush();
      assert.equal(JSON.stringify(bg.tabs.updated.at(-1)), JSON.stringify([5, { active: true }]), 'the video is in front again');
      mock.timers.tick(9000);
      await flush();
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === 5 && m.status === 'need-click').length, 0, 'nothing to ask you');
      assert.match(bg.local.tidalLog.map((e) => e.outcome).join('|'), /showed the TIDAL tab/);
      // next song in the same tab (it has played now): no showing
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
      await bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '2' }, { tab: { id: web }, url: 'https://tidal.com/track/2' });
      await flush();
      mock.timers.tick(3000);
      await flush();
      assert.equal(bg.tabs.updated.length, 2);
    } finally {
      mock.timers.reset();
    }
  });

  test('TIDAL stuck (Pause, nothing loaded): its tab is reloaded while on screen, then Play is pressed again', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
      const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
      bg.tabs.open.push({ id: 5, url: 'https://www.youtube.com/watch?v=x', windowId: 1, active: true });
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '1', at: 0, via: 'web', title: 'Night Ranger - Sister Christian' }, { tab: { id: 5 } });
      await flush();
      const web = bg.tabs.created[0].id;
      bg.tabs.created[0].windowId = 1;
      bg.dbg.answer = 'stuck';
      bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '1' }, { tab: { id: web }, url: 'https://tidal.com/track/1' });
      await flush();
      mock.timers.tick(1000); // a moment to start by itself
      await flush();
      assert.deepEqual([...bg.tabs.reloaded], [web], 'stuck: reloaded');
      // the reloaded tab has the song on its page again; this time Play works
      bg.dbg.answer = 'row';
      await bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '1' }, { tab: { id: web }, url: 'https://tidal.com/track/1' });
      await flush();
      await bg.send({ type: 'tidal-web-status', status: 'playing', trackId: '1', quality: 'LOSSLESS' }, { tab: { id: web } });
      await flush();
      mock.timers.tick(1000);
      await flush();
      assert.equal(JSON.stringify(bg.tabs.updated.at(-1)), JSON.stringify([5, { active: true }]), 'back to the video');
      mock.timers.tick(60000);
      await flush();
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === 5 && m.status === 'need-click').length, 0, 'nothing to ask you');
      const outcomes = bg.local.tidalLog.map((e) => e.outcome);
      assert.ok(outcomes.includes('TIDAL is stuck (Pause, nothing loaded): reloading its tab and starting again'));
      assert.ok(outcomes.includes('started TIDAL for you: pressed the song in TIDAL'));
      assert.ok(outcomes.includes('playing'));
    } finally {
      mock.timers.reset();
    }
  });

  test('TIDAL still silent while shown: the log gets what the TIDAL tab shows, and the song\'s title', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
      const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
      bg.tabs.open.push({ id: 5, url: 'https://www.youtube.com/watch?v=x', windowId: 1, active: true });
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '1', at: 0, via: 'web', title: 'Ramones - Pet Sematary' }, { tab: { id: 5 } });
      await flush();
      const web = bg.tabs.created[0].id;
      bg.tabs.created[0].windowId = 1;
      bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '1', detail: 'tab hidden, bar: Pause' }, { tab: { id: web }, url: 'https://tidal.com/track/1' });
      await flush();
      mock.timers.tick(1000);
      await flush();
      mock.timers.tick(10000); // TIDAL gets up to 10 s on screen
      await flush();
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === web && m.cmd === 'diag').length, 1);
      await bg.send({ type: 'tidal-web-status', status: 'diag', trackId: '1', detail: 'tab visible focused, bar: Play; TIDAL says: Playing on another device' }, { tab: { id: web } });
      mock.timers.tick(10000); // then the video says TIDAL didn't start
      await flush();
      mock.timers.tick(1000);
      await flush();
      const log = bg.local.tidalLog;
      assert.ok(log.some((e) => e.outcome === "started TIDAL for you: pressed the song in TIDAL"), 'what it pressed');
      assert.ok(log.some((e) => /showed the TIDAL tab to start it.*still silent/.test(e.outcome)));
      assert.ok(log.some((e) => e.outcome === 'diag' && /another device/.test(e.detail) && e.video === 'Ramones - Pet Sematary'));
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === 5 && m.status === 'diag').length, 0, 'not sent to the video');
      const ask = log.find((e) => e.outcome === 'need-click');
      assert.match(ask.detail, /tab hidden, bar: Pause/);
    } finally {
      mock.timers.reset();
    }
  });

  test('a new TIDAL tab while the video is full screen: shown for a moment, then the video goes back to full screen', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
      const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
      bg.tabs.windowState = 'fullscreen';
      bg.tabs.open.push({ id: 5, url: 'https://www.youtube.com/watch?v=x', windowId: 1, active: true });
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '1', at: 0, via: 'web' }, { tab: { id: 5 } });
      await flush();
      await bg.send({ type: 'tidal-audio', cmd: 'clock', trackId: '1', videoTime: 3, playing: true, fullscreen: true }, { tab: { id: 5 } });
      await flush();
      const web = bg.tabs.created[0].id;
      bg.tabs.created[0].windowId = 1;
      bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '1' }, { tab: { id: web }, url: 'https://tidal.com/track/1' });
      await flush();
      mock.timers.tick(300);
      await flush();
      await bg.send({ type: 'tidal-web-status', status: 'playing', trackId: '1' }, { tab: { id: web } });
      await flush();
      mock.timers.tick(800);
      await flush();
      mock.timers.tick(300);
      await flush();
      assert.equal(JSON.stringify(bg.tabs.updated), JSON.stringify([[web, { active: true }], [5, { active: true }]]));
      assert.equal(bg.dbg.log.filter(([m, id]) => m === 'Runtime.evaluate' && id === web).length, 0, 'TIDAL started by itself once shown: nothing pressed');
      const onVideo = bg.dbg.log.filter(([m, id]) => m === 'Runtime.evaluate' && id === 5);
      assert.equal(onVideo.length, 1);
      assert.match(onVideo[0][2].expression, /ytp-fullscreen-button/);
      assert.equal(onVideo[0][2].userGesture, true);
    } finally {
      mock.timers.reset();
    }
  });

  test('a TIDAL tab open since before the Player was updated: reloaded so it gets the new script', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.tabs.open.push({ id: 77, url: 'https://tidal.com/album/1/track/2', status: 'complete' });
    bg.tabs.deaf.push(77);
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(bg.tabs.reloaded, [77]);
    bg.tabs.deaf.length = 0;
    await bg.send({ type: 'tidal-web-hello' }, { tab: { id: 77, url: 'https://tidal.com/album/1/track/2' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 77 && m.cmd === 'load').length, 2, 'the song again, after the reload');
    assert.equal(bg.tabs.created.length, 0);
  });

  test('a TIDAL tab Chrome restored after a restart (not loaded yet): reloaded; one still loading is left alone', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.tabs.open.push({ id: 78, url: 'https://tidal.com/album/1/track/2', status: 'unloaded', discarded: true });
    bg.tabs.deaf.push(78);
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(bg.tabs.reloaded, [78]);
    const bg2 = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg2.tabs.open.push({ id: 79, url: 'https://tidal.com/', status: 'loading' });
    bg2.tabs.deaf.push(79);
    await bg2.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(bg2.tabs.reloaded, []);
  });

  test('the TIDAL tab is the one in the video\'s window (one behind a full-screen video in another window can\'t start)', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    const tick = () => new Promise((r) => setTimeout(r, 20));
    bg.tabs.open.push({ id: 5, url: 'https://www.youtube.com/watch?v=x', windowId: 1 });
    bg.tabs.open.push({ id: 70, url: 'https://tidal.com/album/1/track/2', windowId: 2 });
    bg.tabs.open.push({ id: 71, url: 'https://tidal.com/', windowId: 1 });
    bg.session.tidalWebTab = 70; // used before, in the other window
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
    await tick();
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 71 && m.cmd === 'load').length, 1);
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 70 && m.cmd === 'stop').length, 1, 'the other one is stopped');
    assert.equal(bg.tabs.created.length, 0);
    // a hello from another TIDAL tab doesn't take over
    await bg.send({ type: 'tidal-web-hello' }, { tab: { id: 70, url: 'https://tidal.com/' } });
    await tick();
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 70 && m.cmd === 'load').length, 0);
  });

  test('no TIDAL tab in the video\'s window: a new pinned one opens there', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.tabs.open.push({ id: 5, url: 'https://www.youtube.com/watch?v=x', windowId: 3 });
    bg.tabs.open.push({ id: 70, url: 'https://tidal.com/', windowId: 2 });
    bg.session.tidalWebTab = 70;
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '2', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bg.tabs.created.length, 1);
    assert.equal(bg.tabs.created[0].windowId, 3);
    assert.equal(bg.tabs.created[0].pinned, true);
  });

  test('a TIDAL tab you opened yourself: used, and left open after the song', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
      const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
      bg.tabs.open.push({ id: 77, url: 'https://tidal.com/my-collection' });
      await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '1', at: 0, via: 'web' }, { tab: { id: 5 } });
      await flush();
      assert.equal(bg.tabs.created.length, 0);
      await bg.send({ type: 'tidal-audio', cmd: 'stop' }, { tab: { id: 5 } });
      await flush();
      mock.timers.tick(30000);
      await flush();
      assert.deepEqual(bg.tabs.closed, []);
      assert.equal(bg.sentToTabs.filter(([id, m]) => id === 77 && m.cmd === 'stop').length, 1, 'just stopped');
    } finally {
      mock.timers.reset();
    }
  });

  test('a song remembered as "preview only" before 1.10 now plays in your TIDAL tab', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3, userId: '175' };
    bg.local['tidal:vid1abcdefg'] = { at: Date.now(), ttl: 3 * 24 * 3600e3,
      result: { track: null, preview: true, previewTrack: { id: '11009839', title: 'Wild Wild Life' }, reason: 'TIDAL has only a 30-second preview of this song' } };
    const r = await bg.send(video);
    assert.equal(r.track.id, '11009839');
    assert.equal(r.via, 'web');
  });

  test('TIDAL tab silent until a click: the Player does the click itself (TIDAL\'s own Play, as a user action)', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '134283114', at: 0, via: 'web' }, { tab: { id: 5 } });
    await wait();
    const web = bg.tabs.created[0].id;
    await bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '134283114' }, { tab: { id: web }, url: 'https://tidal.com/album/134283113/track/134283114' });
    await wait(1150); // (a new tab is shown first; Play after a moment)
    const [attach, evaluate] = bg.dbg.log;
    assert.deepEqual([...attach], ['attach', web]);
    assert.equal(evaluate[0], 'Runtime.evaluate');
    assert.equal(evaluate[2].userGesture, true);
    assert.match(evaluate[2].expression, /data-track-id="134283114"/);
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 5 && m.status === 'need-click').length, 0, 'nothing to ask you');
    await bg.send({ type: 'tidal-web-status', status: 'loaded', trackId: '134283114' }, { tab: { id: web } });
    await wait(600);
    assert.ok(bg.dbg.log.some(([m]) => m === 'detach'), 'lets go of the tab right after');
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 5 && m.status === 'loaded').length, 1);
    assert.match(bg.local.tidalLog.map((e) => e.outcome).join('|'), /started TIDAL for you/);
  });

  test('the automatic start is only for messages from a tidal.com page', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 30));
    await bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '9' }, { tab: { id: 5 }, url: 'https://www.youtube.com/watch?v=x' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bg.dbg.log.length, 0);
  });

  test('if Chrome refuses the automatic start, the video asks you instead', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.dbg.refuse = true;
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 30));
    const web = bg.tabs.created[0].id;
    bg.tabs.windowState = 'minimized'; // (no showing either)
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await bg.send({ type: 'tidal-web-status', status: 'need-click', trackId: '9' }, { tab: { id: web }, url: 'https://tidal.com/track/9' });
      for (let i = 0; i < 40; i++) await Promise.resolve();
      mock.timers.tick(5000);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    } finally {
      mock.timers.reset();
    }
    assert.equal(bg.sentToTabs.filter(([id, m]) => id === 5 && m.status === 'need-click').length, 1);
  });

  test('"click here" brings your TIDAL tab to the front', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.tabs.open.push({ id: 77, url: 'https://tidal.com/', windowId: 3 });
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 30));
    await bg.send({ type: 'tidal-focus' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 30));
    const [id, opts] = bg.tabs.updated.at(-1);
    assert.equal(id, 77);
    assert.equal(opts.active, true);
    assert.equal(bg.windowsFocused.at(-1), 3);
  });

  test('uses a TIDAL tab you already have open instead of opening one', async () => {
    const bg = loadPlayerBackground({ fetchFn: fetchFn([]) });
    bg.tabs.open.push({ id: 77, url: 'https://tidal.com/my-collection' });
    await bg.send({ type: 'tidal-audio', cmd: 'load', trackId: '9', at: 0, via: 'web' }, { tab: { id: 5 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(bg.tabs.created.length, 0);
    assert.equal(bg.sentToTabs.find(([id]) => id === 77)[1].cmd, 'load');
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
