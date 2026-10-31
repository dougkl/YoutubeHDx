// "Subtitles out of sync" button: run with node --test tests/extension/sync.test.mjs
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlayer, createYoutubePage, loadDefaults, loadLyrics, loadPlayerBackground, runBridge } from './harness.mjs';

const { YHDX_DEFAULTS } = loadDefaults();
const L = loadLyrics();
const plain = (v) => JSON.parse(JSON.stringify(v));
const settings = (over = {}) => ({ ...structuredClone(YHDX_DEFAULTS), forceQuality: false, ...over });
const advance = (ms) => { for (let t = 0; t < ms; t += 100) mock.timers.tick(100); };

const manualEn = { languageCode: 'en', kind: '', vss_id: '.en', displayName: 'English' };
const autoEn = { languageCode: 'en', kind: 'asr', vss_id: 'a.en' };
const CUES = [{ start: 12.5, end: 16, text: 'Ground control to Major Tom' }, { start: 16, end: 20, text: 'Commencing countdown' }];
const LYRICS_META = { id: 'lrclib:111', source: 'LRCLIB', matched: 'Peter Schilling - Major Tom (300 s)' };

const lyricsRequests = (page) => page.posted.filter((m) => m.__yhdx === 'lyrics-request');
const trackSets = (page) => page.player.calls.filter((c) => c[0] === 'setOption' && c[2] === 'track');

function watch({ tracks = [manualEn], saved, over } = {}) {
  const page = createYoutubePage({ player: new FakePlayer({ tracks }) });
  if (saved) page.savedPrefs.vid1 = saved;
  page.sendSettings(settings(over));
  advance(600);
  return page;
}

function watchWithLyrics() {
  const page = watch({ tracks: [autoEn] });
  page.sendLyrics('vid1', CUES, LYRICS_META);
  return page;
}

describe('the out-of-sync button', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('sits in the control bar while YouTube captions are showing, with the right menu', () => {
    const page = watch();
    const btn = page.syncButton();
    assert.ok(btn, 'button added to .ytp-right-controls');
    assert.equal(btn.style.display, '');
    assert.equal(btn.attrs['aria-label'], 'Subtitles out of sync?');
    btn.click();
    assert.match(page.menu().children[0].textContent, /Showing: English/);
    assert.deepEqual(page.menuItems(), ['Out of sync: try other subtitles', 'Turn subtitles off for this video']);
    btn.click();
    assert.equal(page.menu(), undefined); // second click closes it
  });

  test('goes right next to YouTube\'s CC button (new control-bar layout)', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn] }) });
    // YouTube's current layout: .ytp-right-controls > .ytp-right-controls-left > [..., CC, settings]
    const doc = page.player.controls;
    const mk = (cls) => { const e = page.makeElement('div'); e.className = cls; return e; };
    const group = mk('ytp-right-controls-left');
    const autoplay = mk('ytp-button');
    const cc = mk('ytp-subtitles-button ytp-button');
    const gear = mk('ytp-settings-button ytp-button');
    for (const e of [autoplay, cc, gear]) group.appendChild(e);
    doc.appendChild(group);
    page.sendSettings(settings());
    advance(600);
    const names = group.children.map((c) => c.className.split(' ')[0]);
    assert.deepEqual(names, ['ytp-button', 'ytp-button', 'ytp-subtitles-button', 'ytp-settings-button']);
    assert.match(group.children[1].className, /yhdx-sync-button/);
  });

  test('is hidden when nothing is managed (captions left to YouTube)', () => {
    const page = watch({ over: { captions: 'leave' } });
    assert.equal(page.syncButton().style.display, 'none');
  });

  test('YouTube captions out of sync: turned off for this video, lyrics looked up instead', () => {
    const page = watch();
    page.syncButton().click();
    page.player.calls.length = 0;
    page.chooseMenu('Out of sync: try other subtitles');

    assert.deepEqual(plain(page.savedPrefs.vid1), { rejectYoutube: true });
    assert.ok(page.player.callsNamed('unloadModule').length >= 1); // YouTube captions off
    assert.equal(lyricsRequests(page).length, 1);
    assert.equal(page.toastText(), 'Looking for other subtitles…');

    page.sendLyrics('vid1', CUES, LYRICS_META);
    assert.equal(page.toastText(), 'Now showing lyrics from LRCLIB');
    assert.ok(page.lyricsWindow());
  });

  test('remembered: next time that video plays, YouTube\'s track is skipped and lyrics are used', () => {
    const page = watch({ saved: { rejectYoutube: true } });
    assert.equal(trackSets(page).filter((c) => c[3]?.languageCode).length, 0);
    assert.equal(lyricsRequests(page).length, 1);
    assert.equal(page.syncButton().style.display, ''); // still reachable to undo
  });

  test('lyrics out of sync: that set is rejected and the next match is asked for', () => {
    const page = watchWithLyrics();
    page.syncButton().click();
    assert.deepEqual(page.menuItems(), [
      'Out of sync: try other lyrics', 'Show lyrics 0.5 s earlier', 'Show lyrics 0.5 s later', 'Turn subtitles off for this video',
    ]);
    page.chooseMenu('Out of sync: try other lyrics');

    assert.deepEqual(plain(page.savedPrefs.vid1), { rejectedLyrics: ['lrclib:111'], offset: 0 });
    assert.equal(page.lyricsWindow(), undefined); // bad lyrics gone at once
    const req = lyricsRequests(page);
    assert.equal(req.length, 2);
    assert.deepEqual(plain(req[1].exclude), ['lrclib:111']);

    page.sendLyrics('vid1', null);
    assert.equal(page.toastText(), 'No other subtitles found for this video');
  });

  test('nudging lyrics earlier/later shifts the timing and is saved', () => {
    const page = watchWithLyrics();
    const span = () => page.lyricsWindow().children[0];
    page.player.time = 12.1; advance(300);
    assert.equal(page.lyricsWindow().style.display, 'none'); // line starts at 12.5

    page.syncButton().click();
    page.chooseMenu('Show lyrics 0.5 s earlier');
    advance(300);
    assert.equal(span().textContent, 'Ground control to Major Tom'); // now from 12.0
    assert.equal(page.toastText(), 'Lyrics timing: -0.5 s');
    assert.deepEqual(plain(page.savedPrefs.vid1), { offset: -0.5 });

    page.syncButton().click();
    assert.match(page.menu().children[0].textContent, /timing -0\.5 s/);
    page.chooseMenu('Show lyrics 0.5 s later');
    page.syncButton().click();
    page.chooseMenu('Show lyrics 0.5 s later');
    assert.equal(page.toastText(), 'Lyrics timing: +0.5 s');
  });

  test('turning subtitles off for a video sticks, and Reset brings them back', () => {
    const page = watch();
    page.syncButton().click();
    page.chooseMenu('Turn subtitles off for this video');
    assert.deepEqual(plain(page.savedPrefs.vid1), { off: true });
    assert.equal(page.toastText(), 'Subtitles off for this video');

    // Next visit: off, no lyrics lookup, button offers Reset.
    const again = watch({ saved: { off: true } });
    assert.equal(trackSets(again).filter((c) => c[3]?.languageCode).length, 0);
    assert.equal(lyricsRequests(again).length, 0);
    again.syncButton().click();
    assert.deepEqual(again.menuItems(), ['Reset subtitles for this video']);

    again.player.calls.length = 0;
    again.chooseMenu('Reset subtitles for this video');
    advance(600);
    assert.deepEqual(plain(again.savedPrefs.vid1), {});
    assert.equal(trackSets(again).filter((c) => c[3]?.languageCode).length, 1); // YouTube captions picked again
  });

  test('with lyrics switched off in settings, "try other" says so instead of failing silently', () => {
    const page = watch({ over: { lyricsWhenNoCaptions: false } });
    page.syncButton().click();
    page.chooseMenu('Out of sync: try other subtitles');
    assert.match(page.toastText(), /lyrics are turned off/);
    assert.equal(lyricsRequests(page).length, 0);
  });

  test('captions still get chosen if the saved choices never arrive', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn] }) });
    page.answerPrefs = false;
    page.sendSettings(settings());
    advance(600);
    assert.equal(trackSets(page).length, 0); // waiting briefly for this video's choices
    advance(2000);
    assert.equal(trackSets(page).filter((c) => c[3]?.languageCode).length, 1);
  });

  test('a lyrics reply that arrives after the player restarts is still shown', () => {
    const page = watch({ tracks: [autoEn] });
    page.fireVideoLoaded(); // e.g. after an ad: state restarts
    page.sendLyrics('vid1', CUES, LYRICS_META);
    assert.ok(page.lyricsWindow());
  });

  test('comes back if YouTube rebuilds its control bar', () => {
    const page = watch();
    page.player.controls.children = [];
    page.fireWindow('yt-navigate-finish');
    advance(600);
    assert.ok(page.syncButton());
  });

  test('menu and choices belong to one video: switching videos closes the menu', () => {
    const page = watch();
    page.syncButton().click();
    assert.ok(page.menu());
    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish'); // what YouTube fires when you move to another video
    advance(600);
    assert.equal(page.menu(), undefined);
  });
});

describe('the bridge stores choices per video', () => {
  test('answers with saved choices', async () => {
    const posted = await runBridge({}, { local: { 'prefs:wO0A0XcWy88': { offset: 1.5 } } });
    await posted.receive({ __yhdx: 'prefs-request', videoId: 'wO0A0XcWy88' });
    assert.deepEqual(plain(posted.find((p) => p.__yhdx === 'prefs')), { __yhdx: 'prefs', videoId: 'wO0A0XcWy88', prefs: { offset: 1.5 } });
  });

  test('saves only known fields, clamps the offset, and removes empty entries', async () => {
    const posted = await runBridge();
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'wO0A0XcWy88', prefs: { offset: 99, rejectYoutube: true, junk: 'x', off: 'yes' } });
    assert.deepEqual(plain(posted.local['prefs:wO0A0XcWy88']), { rejectYoutube: true, offset: 30 });
    await posted.receive({ __yhdx: 'prefs-save', videoId: 'wO0A0XcWy88', prefs: {} });
    assert.equal(posted.local['prefs:wO0A0XcWy88'], undefined);
  });

  test('ignores bad video ids', async () => {
    const posted = await runBridge();
    await posted.receive({ __yhdx: 'prefs-save', videoId: '../x', prefs: { off: true } });
    await posted.receive({ __yhdx: 'prefs-request', videoId: '../x' });
    assert.deepEqual(Object.keys(posted.local), []);
    assert.equal(posted.find((p) => p.__yhdx === 'prefs'), undefined);
  });

  test('passes rejected lyrics on and returns the new lyrics id', async () => {
    const sent = [];
    const posted = await runBridge({}, { lyricsReply: { cues: CUES, id: 'lrclib:222', source: 'LRCLIB', matched: 'x' }, onSend: (m) => sent.push(m) });
    await posted.receive({ __yhdx: 'lyrics-request', videoId: 'wO0A0XcWy88', title: 'A - B', author: 'A', duration: 300, exclude: ['lrclib:111'] });
    assert.deepEqual(plain(sent[0].exclude), ['lrclib:111']);
    const reply = posted.find((p) => p.__yhdx === 'lyrics');
    assert.equal(reply.id, 'lrclib:222');
    assert.equal(reply.matched, 'x');
  });
});

describe('finding other lyrics', () => {
  const LRC = '[00:12.50] Ground control\n[00:16.00] Commencing countdown\n';
  const r = (id, duration) => ({ id, duration, syncedLyrics: LRC, instrumental: false, trackName: 'Major Tom', artistName: 'Peter Schilling' });
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => String(body) });
  const VIDEO = { title: 'Peter Schilling - Major Tom (Coming Home) (Official Video)', author: 'Peter Schilling', duration: 300 };

  test('results carry an id', async () => {
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn: async () => json([r(111, 300)]) });
    assert.equal(res.id, 'lrclib:111');
  });

  test('a rejected set is skipped for the next closest match', async () => {
    const results = [r(111, 300), r(222, 301.5), r(333, 310)];
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn: async () => json(results), exclude: ['lrclib:111'] });
    assert.equal(res.id, 'lrclib:222');
  });

  test('nothing else within 3 s: none (never a badly timed one)', async () => {
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn: async () => json([r(111, 300), r(333, 310)]), exclude: ['lrclib:111'] });
    assert.equal(res.cues, null);
  });

  test('rejected OpenSubtitles files are skipped too', async () => {
    let downloads = 0;
    const fetchFn = async (url) => {
      if (url.startsWith('https://lrclib.net/')) return json([]);
      if (url.includes('/subtitles?')) return json({ data: [{ attributes: { feature_details: { title: 'Major Tom (Coming Home)' }, files: [{ file_id: 5 }] } }] });
      downloads++; return json({});
    };
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn, openSubtitlesKey: 'K', exclude: ['os:5'] });
    assert.equal(res.cues, null);
    assert.equal(downloads, 0);
  });

  test('"try other" lookups bypass the cache and do not overwrite it', async () => {
    let n = 0;
    const bg = loadPlayerBackground({ fetchFn: async () => { n++; return json([r(111, 300), r(222, 299)]); } });
    const first = await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    assert.equal(first.id, 'lrclib:111');
    const other = await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO, exclude: ['lrclib:111'] });
    assert.equal(other.id, 'lrclib:222');
    assert.equal(n, 2);
    const cachedAgain = await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    assert.equal(cachedAgain.id, 'lrclib:111'); // the plain cache entry is unchanged
    assert.equal(n, 2);
  });
});
