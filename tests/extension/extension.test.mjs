// Run: node --test tests/extension/
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlayer, createYoutubePage, loadBackground, loadDefaults, readManifest } from './harness.mjs';

const { YHDX_DEFAULTS, yhdxBuildCaptionCss, yhdxHexToRgba } = loadDefaults();
/** Advances the mock clock in small steps so chained setTimeout retries all run. */
const advance = (ms) => { for (let t = 0; t < ms; t += 100) mock.timers.tick(100); };
/** Objects made inside the vm sandbox have a foreign prototype; compare plain copies. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const settings = (over = {}) => ({ ...structuredClone(YHDX_DEFAULTS), ...over });

const manualEn = { languageCode: 'en', kind: '', vss_id: '.en', displayName: 'English' };
const manualEnGb = { languageCode: 'en-GB', kind: '', vss_id: '.en-GB', displayName: 'English (UK)' };
const autoEn = { languageCode: 'en', kind: 'asr', vss_id: 'a.en', displayName: 'English (auto-generated)' };
const manualEs = { languageCode: 'es', kind: '', vss_id: '.es', displayName: 'Spanish' };

// ---------------------------------------------------------------- content-main.js

describe('player: quality', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('switches to 4K when the video has it', () => {
    const page = createYoutubePage();
    page.sendSettings(settings({ captions: 'leave' }));
    advance(600);
    assert.deepEqual(plain(page.player.callsNamed('setPlaybackQualityRange')[0]), ['setPlaybackQualityRange', 'hd2160', 'hd2160']);
    assert.deepEqual(page.player.callsNamed('setPlaybackQuality')[0], ['setPlaybackQuality', 'hd2160']);
  });

  test('default setting plays the highest resolution the video has', () => {
    assert.equal(YHDX_DEFAULTS.quality, 'highres');
    const page = createYoutubePage({ player: new FakePlayer({ levels: ['hd2880', 'hd2160', 'hd1440', 'auto'] }) });
    page.sendSettings(settings({ captions: 'leave' }));
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality')[0][1], 'hd2880');
  });

  test('default captions setting is human-made English only', () => {
    assert.equal(YHDX_DEFAULTS.captions, 'english');
  });

  test('falls back to the best level below 4K', () => {
    const page = createYoutubePage({ player: new FakePlayer({ levels: ['hd1080', 'hd720', 'large', 'auto'] }) });
    page.sendSettings(settings({ captions: 'leave' }));
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality')[0][1], 'hd1080');
  });

  test('"highest available" picks 8K/5K over 4K', () => {
    const page = createYoutubePage({ player: new FakePlayer({ levels: ['highres', 'hd2880', 'hd2160', 'auto'] }) });
    page.sendSettings(settings({ quality: 'highres', captions: 'leave' }));
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality')[0][1], 'highres');
  });

  test('does not touch quality when disabled', () => {
    const page = createYoutubePage();
    page.sendSettings(settings({ forceQuality: false, captions: 'leave' }));
    advance(5000);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 0);
  });

  test('waits for ads to finish, then applies', () => {
    const page = createYoutubePage();
    page.player.ad = true;
    page.sendSettings(settings({ captions: 'leave' }));
    advance(3000);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 0);

    page.player.ad = false;
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 1);
  });

  test('retries until quality levels are loaded', () => {
    const page = createYoutubePage({ player: new FakePlayer({ levels: [] }) });
    page.sendSettings(settings({ captions: 'leave' }));
    advance(1600);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 0);

    page.player.levels = ['hd2160', 'auto'];
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality')[0][1], 'hd2160');
  });

  test('does nothing off watch pages (home, search, channel)', () => {
    const page = createYoutubePage({ pathname: '/results' });
    page.sendSettings(settings());
    advance(5000);
    assert.equal(page.player.calls.length, 0);
  });

  test('re-applies on SPA navigation and new video, but not on its own reloads', () => {
    const page = createYoutubePage();
    page.sendSettings(settings({ captions: 'leave' }));
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 1);

    page.fireVideoLoaded(); // same video (e.g. after our own quality switch): no loop
    advance(3000);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 1);

    page.player.videoId = 'vid2';
    page.fireWindow('yt-navigate-finish');
    advance(600);
    assert.equal(page.player.callsNamed('setPlaybackQuality').length, 2);
  });

  test('stops retrying after ~20 s if the player never becomes usable', () => {
    const page = createYoutubePage({ player: new FakePlayer({ levels: [] }) });
    page.sendSettings(settings({ captions: 'leave' }));
    advance(60_000);
    const levelsCallsBefore = page.player.calls.length;
    page.player.levels = ['hd2160'];
    advance(10_000);
    assert.equal(page.player.calls.length, levelsCallsBefore);
  });
});

describe('player: captions', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  const trackSet = (page) => page.player.callsNamed('setOption').filter((c) => c[2] === 'track').map((c) => c[3]);

  test('picks human-made English even when auto-generated is listed first', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [autoEn, manualEs, manualEn] }) });
    page.sendSettings(settings({ forceQuality: false }));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [manualEn]);
  });

  test('turns captions off when only auto-generated English exists', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [autoEn, manualEs] }) });
    page.sendSettings(settings({ forceQuality: false }));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [{}]);
    assert.ok(page.player.callsNamed('unloadModule').some((c) => c[1] === 'captions'));
  });

  test('also detects auto captions by vss_id when kind is missing', () => {
    const sneakyAuto = { languageCode: 'en', vss_id: 'a.en' };
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [sneakyAuto] }) });
    page.sendSettings(settings({ forceQuality: false }));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [{}]);
  });

  test('follows the language preference order', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn, manualEnGb] }) });
    page.sendSettings(settings({ forceQuality: false, captionLanguages: ['en-GB', 'en'] }));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [manualEnGb]);
  });

  test('accepts any English variant when the preferred codes are missing', () => {
    const enCa = { languageCode: 'en-CA', kind: '', vss_id: '.en-CA' };
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEs, enCa] }) });
    page.sendSettings(settings({ forceQuality: false, captionLanguages: ['en'] }));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [enCa]);
  });

  test('loads the captions module when the track list starts empty', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn], lazyTracks: true }) });
    page.sendSettings(settings({ forceQuality: false }));
    advance(600);
    assert.ok(page.player.callsNamed('loadModule').some((c) => c[1] === 'captions'));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [manualEn]);
  });

  test('gives up and keeps captions off on videos with no captions at all', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [] }) });
    page.sendSettings(settings({ forceQuality: false }));
    advance(10_000);
    assert.deepEqual(plain(trackSet(page)), [{}]);
    const callsAfterGivingUp = page.player.calls.length;
    advance(30_000);
    assert.equal(page.player.calls.length, callsAfterGivingUp); // stopped polling
  });

  test('"off" mode always turns captions off', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn] }) });
    page.sendSettings(settings({ forceQuality: false, captions: 'off' }));
    advance(600);
    assert.deepEqual(plain(trackSet(page)), [{}]);
  });

  test('"leave" mode never touches captions', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn] }) });
    page.sendSettings(settings({ forceQuality: false, captions: 'leave' }));
    advance(5000);
    assert.equal(page.player.calls.length, 0);
  });
});

describe('player: caption repair (YouTube returns no caption data)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  const CAPTIONS = 'https://www.youtube.com/api/timedtext?v=vid1&lang=en&name=&fmt=json3&pot=xyz';
  const GOOD = JSON.stringify({ events: [{ tStartMs: 1200, segs: [{ utf8: 'I TOUCH MYSELF' }] }] });

  /** Page where our extension already picked the human-made English track. */
  function watching(over = {}) {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn] }) });
    page.sendSettings(settings({ forceQuality: false, ...over }));
    advance(600);
    page.player.calls.length = 0; // only count what the repair does
    return page;
  }
  const reselects = (page) => page.player.calls.filter((c) => c[0] === 'setOption' && c[2] === 'track' && c[3]?.languageCode);

  test('empty caption reply: reloads captions and re-selects the track (like toggling CC)', () => {
    const page = watching();
    page.captionXhr(CAPTIONS).finish(200, '');
    advance(1000);
    assert.equal(page.player.calls.length, 0); // waits a moment first
    advance(1400);
    assert.deepEqual(page.player.calls.map((c) => c[0]), ['unloadModule', 'loadModule', 'setOption']);
    assert.deepEqual(plain(reselects(page)[0][3]), manualEn);
  });

  test('JSON reply with no caption events counts as empty', () => {
    const page = watching();
    page.captionXhr(CAPTIONS).finish(200, '{"wireMagic":"pb3","events":[]}');
    advance(2500);
    assert.equal(reselects(page).length, 1);
  });

  test('a good reply never triggers a repair', () => {
    const page = watching();
    page.captionXhr(CAPTIONS).finish(200, GOOD);
    advance(30_000);
    assert.equal(page.player.calls.length, 0);
  });

  test('a failure followed by a good reply is left alone', () => {
    const page = watching();
    page.captionXhr(CAPTIONS).finish(0, '');     // aborted
    page.captionXhr(CAPTIONS).finish(200, GOOD); // player asked again by itself and got data
    advance(30_000);
    assert.equal(page.player.calls.length, 0);
  });

  test('a request that never finishes is treated as failed after 8 s', () => {
    const page = watching();
    page.captionXhr(CAPTIONS); // hangs
    advance(7000);
    assert.equal(page.player.calls.length, 0);
    advance(1000 + 2200);
    assert.equal(reselects(page).length, 1);
  });

  test('ignores auto-generated captions and captions for other videos (ads)', () => {
    const page = watching();
    page.captionXhr('https://www.youtube.com/api/timedtext?v=vid1&kind=asr&lang=en').finish(200, '');
    page.captionXhr('https://www.youtube.com/api/timedtext?v=adVideo&lang=en').finish(200, '');
    page.captionXhr('https://www.youtube.com/youtubei/v1/player').finish(200, '');
    advance(30_000);
    assert.equal(page.player.calls.length, 0);
  });

  test('keeps failing: two re-requests, then one reload at the same second, then stops', () => {
    const page = watching();
    const fail = () => page.captionXhr(CAPTIONS).finish(200, '');
    fail(); advance(2500);          // repair 1
    fail(); advance(4800);          // repair 2
    fail(); advance(10_800);        // repair 3 = reload video
    fail(); advance(30_000);        // no more
    assert.equal(page.player.callsNamed('unloadModule').length, 2);
    const reloads = page.player.callsNamed('loadVideoById');
    assert.equal(reloads.length, 1);
    assert.deepEqual(plain(reloads[0][1]), { videoId: 'vid1', startSeconds: 41.5 });
  });

  test('waits while an ad is showing', () => {
    const page = watching();
    page.player.ad = true;
    page.captionXhr(CAPTIONS).finish(200, '');
    advance(20_000);
    assert.equal(reselects(page).length, 0);
    page.player.ad = false;
    advance(5000);
    assert.equal(reselects(page).length, 1);
  });

  test('does nothing when captions are set to off', () => {
    const page = watching({ captions: 'off' });
    page.captionXhr(CAPTIONS).finish(200, '');
    advance(30_000);
    assert.equal(reselects(page).length, 0);
    assert.equal(page.player.callsNamed('loadVideoById').length, 0);
  });

  test('never switches to auto-generated captions while repairing', () => {
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [autoEn] }) });
    page.sendSettings(settings({ forceQuality: false, captions: 'leave' }));
    page.player.currentTrack = autoEn; // YouTube itself chose auto captions
    page.captionXhr(CAPTIONS).finish(200, '');
    advance(30_000);
    assert.equal(reselects(page).length, 0);
  });

  test('the request itself passes through untouched', () => {
    const page = watching();
    const x = page.captionXhr(CAPTIONS);
    assert.equal(page.xhrLog.length, 1);
    assert.equal(page.xhrLog[0], x);
    assert.equal(x.method, 'GET');
    assert.equal(x.url, CAPTIONS);
  });

  test('also watches fetch, and hands the reply back unchanged', async () => {
    mock.timers.reset(); // real timers for the promise chain
    const page = createYoutubePage({ player: new FakePlayer({ tracks: [manualEn] }) });
    page.sendSettings(settings({ forceQuality: false }));
    await new Promise((r) => setTimeout(r, 700));
    page.player.calls.length = 0;

    const res = await page.captionFetch(CAPTIONS, 200, '');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ''); // caller still gets the body
    await new Promise((r) => setTimeout(r, 2400));
    assert.equal(reselects(page).length, 1);
  });
});

describe('player: caption style', () => {
  test('injects the style sheet and removes it when disabled', () => {
    const page = createYoutubePage();
    page.sendSettings(settings({ captions: 'leave', forceQuality: false }), '.ytp-caption-segment{color:red}');
    assert.equal(page.elements.get('yhdx-caption-style').textContent, '.ytp-caption-segment{color:red}');

    page.sendSettings(settings({ captions: 'leave', forceQuality: false }), '');
    assert.equal(page.elements.has('yhdx-caption-style'), false);
  });

  test('asks the bridge for settings on load', () => {
    const page = createYoutubePage();
    assert.deepEqual(plain(page.posted), [{ __yhdx: 'ready' }]);
  });
});

// ---------------------------------------------------------------- defaults.js

describe('caption CSS builder', () => {
  test('defaults are Doug\'s style: 14px yellow, outlined, no background box', () => {
    const css = yhdxBuildCaptionCss(YHDX_DEFAULTS.captionStyle);
    assert.match(css, /font-family: "Segoe UI", Roboto, Arial, sans-serif !important/);
    assert.match(css, /font-size: 14px !important/);
    assert.match(css, /color: #ffea00 !important/);
    assert.match(css, /background: rgba\(0, 0, 0, 0\) !important/);
    assert.match(css, /text-shadow: -1px -1px 0 #000/);
  });

  test('drop-shadow edge still available', () => {
    const css = yhdxBuildCaptionCss({ ...YHDX_DEFAULTS.captionStyle, edge: 'drop-shadow', backgroundOpacity: 0.6 });
    assert.match(css, /text-shadow: 2px 2px 3px/);
    assert.match(css, /background: rgba\(0, 0, 0, 0\.6\) !important/);
  });

  test('returns nothing when styling is disabled', () => {
    assert.equal(yhdxBuildCaptionCss({ ...YHDX_DEFAULTS.captionStyle, enabled: false }), '');
  });

  test('clamps sizes and rejects bad colours', () => {
    const css = yhdxBuildCaptionCss({ ...YHDX_DEFAULTS.captionStyle, fontSizePx: 500, color: 'red; } body { display:none' });
    assert.match(css, /font-size: 96px/);
    assert.match(css, /color: #ffffff/); // invalid colour falls back to white
  });

  test('strips characters that could break out of the rule', () => {
    const css = yhdxBuildCaptionCss({ ...YHDX_DEFAULTS.captionStyle, fontFamily: 'Arial} body{display:none' });
    assert.equal((css.match(/[{}]/g) || []).length, 2); // only the rule's own braces
    assert.doesNotMatch(css, /display:none;/);
  });

  test('hex to rgba', () => {
    assert.equal(yhdxHexToRgba('#ff8000', 0.5), 'rgba(255, 128, 0, 0.5)');
    assert.equal(yhdxHexToRgba('nope', 2), 'rgba(0, 0, 0, 1)');
  });
});

// ---------------------------------------------------------------- background.js

describe('background: URL parsing', () => {
  const { parse } = loadBackground();

  test('watch URL inside a playlist', () => {
    const r = parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4');
    assert.equal(r.videoUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(r.playlistUrl, 'https://www.youtube.com/playlist?list=PL123');
    assert.equal(r.isMix, false);
  });

  test('short links, shorts, live and mobile', () => {
    assert.equal(parse('https://youtu.be/abcdefghijk?t=30').videoId, 'abcdefghijk');
    assert.equal(parse('https://www.youtube.com/shorts/abcdefghijk').videoId, 'abcdefghijk');
    assert.equal(parse('https://www.youtube.com/live/abcdefghijk').videoId, 'abcdefghijk');
    assert.equal(parse('https://m.youtube.com/watch?v=abcdefghijk').videoId, 'abcdefghijk');
  });

  test('playlist page', () => {
    const r = parse('https://www.youtube.com/playlist?list=PLxyz');
    assert.equal(r.videoUrl, null);
    assert.equal(r.playlistUrl, 'https://www.youtube.com/playlist?list=PLxyz');
  });

  test('flags endless Mixes', () => {
    assert.equal(parse('https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk').isMix, true);
  });

  test('ignores non-YouTube and look-alike hosts', () => {
    assert.equal(parse('https://example.com/watch?v=abc'), null);
    assert.equal(parse('https://youtube.com.evil.example/watch?v=abc'), null);
    assert.equal(parse('not a url'), null);
  });
});

describe('background: talking to the host', () => {
  const cookie = {
    domain: '.youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: true,
    session: false, expirationDate: 1800000000.5, name: 'LOGIN_INFO', value: 'v', storeId: '0', sameSite: 'lax',
  };

  test('download sends URL, mode and mapped cookies to the native host', async () => {
    const bg = loadBackground({ cookies: [cookie] });
    const reply = await bg.message({ type: 'download', url: 'https://www.youtube.com/watch?v=abc', noPlaylist: true });

    assert.equal(reply.ok, true);
    assert.equal(bg.sent[0].host, 'com.doug.youtubehdx');
    const msg = bg.sent[0].msg;
    assert.equal(msg.type, 'download');
    assert.equal(msg.noPlaylist, true);
    assert.deepEqual(Object.keys(msg.cookies[0]).sort(),
      ['domain', 'expirationDate', 'hostOnly', 'httpOnly', 'name', 'path', 'secure', 'session', 'value']);
    assert.equal(bg.badges[0], 'OK');
  });

  test('explains a missing host install instead of a raw Chrome error', async () => {
    const bg = loadBackground({ nativeError: 'Specified native messaging host not found.' });
    const reply = await bg.message({ type: 'download', url: 'https://www.youtube.com/watch?v=abc', noPlaylist: true });
    assert.equal(reply.ok, false);
    assert.match(reply.message, /Install-Downloader\.cmd/);
    assert.equal(bg.badges[0], '!');
  });

  test('pause and resume are forwarded to the app', async () => {
    const bg = loadBackground();
    await bg.message({ type: 'pause', minutes: 60 });
    await bg.message({ type: 'pause', minutes: null });
    await bg.message({ type: 'pause', minutes: -5 });
    await bg.message({ type: 'resume' });
    assert.deepEqual(plain(bg.sent.map((s) => s.msg)), [
      { type: 'pause', minutes: 60 },
      { type: 'pause', minutes: null },  // until resumed
      { type: 'pause', minutes: null },  // invalid length never becomes a negative pause
      { type: 'resume' },
    ]);
  });

  test('status and cancel are forwarded without cookies', async () => {
    const bg = loadBackground({ cookies: [cookie] });
    await bg.message({ type: 'status' });
    await bg.message({ type: 'cancel', jobId: 'abc' });
    assert.deepEqual(plain(bg.sent.map((s) => s.msg)), [{ type: 'status' }, { type: 'cancel', jobId: 'abc' }]);
  });

  test('right-click on a playlist link downloads the playlist; Mixes are refused', async () => {
    const bg = loadBackground();
    await bg.listeners.menuClicked({ linkUrl: 'https://www.youtube.com/playlist?list=PL9' });
    assert.deepEqual(bg.sent[0].msg.url, 'https://www.youtube.com/playlist?list=PL9');
    assert.equal(bg.sent[0].msg.noPlaylist, false);

    await bg.listeners.menuClicked({ linkUrl: 'https://www.youtube.com/playlist?list=RDxyz' });
    assert.equal(bg.sent.length, 1);
  });

  test('right-click on a video inside a playlist downloads just the video', async () => {
    const bg = loadBackground();
    await bg.listeners.menuClicked({ pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=PL9' });
    assert.equal(bg.sent[0].msg.url, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(bg.sent[0].msg.noPlaylist, true);
  });

  test('periodic cookie refresh only runs while signed in', async () => {
    const signedOut = loadBackground({ cookies: [{ ...cookie, name: 'PREF' }] });
    await signedOut.listeners.alarm({ name: 'yhdx-cookies' });
    assert.equal(signedOut.sent.length, 0);

    const signedIn = loadBackground({ cookies: [cookie] });
    await signedIn.listeners.alarm({ name: 'yhdx-cookies' });
    assert.equal(signedIn.sent[0].msg.type, 'cookies');
  });

  test('sends the login on install and on every Chrome start', async () => {
    const bg = loadBackground({ cookies: [cookie] });
    bg.listeners.installed();
    bg.listeners.startup();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(bg.sent.map((s) => s.msg.type), ['cookies', 'cookies']);
  });

  test('popup login check reports signed-out without overwriting the saved login', async () => {
    const bg = loadBackground({ cookies: [{ ...cookie, name: 'PREF' }] });
    const reply = await bg.message({ type: 'login' });
    assert.equal(reply.signedIn, false);
    assert.equal(bg.sent.length, 0);
  });

  test('popup login check reports signed-in after the host saves it', async () => {
    const bg = loadBackground({ cookies: [cookie], nativeReply: { ok: true, message: 'Signed in.' } });
    const reply = await bg.message({ type: 'login' });
    assert.equal(reply.signedIn, true);
    assert.equal(bg.sent[0].msg.cookies[0].name, 'LOGIN_INFO');
  });

  test('installs both context menu entries', () => {
    const bg = loadBackground();
    bg.listeners.installed();
    assert.deepEqual(bg.menus.map((m) => m.id), ['yhdx-link', 'yhdx-page']);
  });
});

// ---------------------------------------------------------------- the two extensions stay separate

describe('extension split', () => {
  const player = readManifest('player');
  const downloader = readManifest('downloader');

  test('player never gets cookies or native messaging', () => {
    assert.deepEqual(player.permissions, ['storage']);
    assert.equal(player.host_permissions, undefined);
    assert.equal(player.key, undefined);
  });

  test('player runs the 4K/caption scripts on YouTube', () => {
    const files = player.content_scripts.flatMap((c) => c.js);
    assert.deepEqual(files.sort(), ['content-bridge.js', 'content-main.js', 'defaults.js']);
    assert.equal(player.content_scripts.find((c) => c.js.includes('content-main.js')).world, 'MAIN');
  });

  test('downloader keeps the fixed key the host is registered for, and touches no pages', () => {
    assert.ok(downloader.key && downloader.key.length > 300);
    assert.ok(downloader.permissions.includes('nativeMessaging'));
    assert.ok(downloader.permissions.includes('cookies'));
    assert.equal(downloader.content_scripts, undefined);
  });

  test('every file a manifest references exists', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    for (const [dir, m] of [['extension-player', player], ['extension-downloader', downloader]]) {
      const base = fileURLToPath(new URL(`../../${dir}/`, import.meta.url));
      const refs = [
        m.background?.service_worker, m.action?.default_popup, m.options_page,
        ...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {}),
        ...(m.content_scripts ?? []).flatMap((c) => c.js),
      ].filter(Boolean);
      for (const r of refs) assert.ok(existsSync(base + r), `${dir}/${r} missing`);
    }
  });
});
