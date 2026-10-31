// Run: node --test tests/extension/lyrics.test.mjs
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlayer, createYoutubePage, loadDefaults, loadLyrics, loadPlayerBackground, runBridge } from './harness.mjs';

const L = loadLyrics();
const { YHDX_DEFAULTS } = loadDefaults();
const plain = (v) => JSON.parse(JSON.stringify(v));
const settings = (over = {}) => ({ ...structuredClone(YHDX_DEFAULTS), ...over });
const advance = (ms) => { for (let t = 0; t < ms; t += 100) mock.timers.tick(100); };

const LRC = `[ar:Peter Schilling]
[00:12.50] Ground control to Major Tom
[00:16.00] Commencing countdown, engines on
[00:20.25]
[01:02.10][02:30.00] Four, three, two, one
`;

// ---------------------------------------------------------------- title parsing

describe('artist and song from the video title', () => {
  const first = (title, author) => plain(L.yhdxParseVideoTitle(title, author)[0]);

  test('"Artist - Song (Official Video)"', () => {
    assert.deepEqual(first('Peter Schilling - Major Tom (Coming Home) (Official Video)', 'Peter Schilling'),
      { artist: 'Peter Schilling', track: 'Major Tom (Coming Home)' }); // keeps parentheses that are part of the name
  });

  test('strips [HD], (Official HD Remaster), (Official Music Video), 4K and the like', () => {
    assert.equal(first('Eagles - I Can\'t Tell You Why (Official Video) [HD]', 'Eagles').track, 'I Can\'t Tell You Why');
    assert.equal(first('Motley Crue - Kickstart My Heart (Official HD Remaster)', 'Mötley Crüe').track, 'Kickstart My Heart');
    assert.equal(first('Divinyls - I Touch Myself (Official Music Video)', 'DivinylsVEVO').track, 'I Touch Myself');
    assert.equal(first('Song Name [4K Remastered]', 'Some Band').track, 'Song Name');
  });

  test('handles en/em dashes and quoted titles', () => {
    assert.deepEqual(first('Simple Minds – "Don\'t You (Forget About Me)"', 'x'), { artist: 'Simple Minds', track: 'Don\'t You (Forget About Me)' });
  });

  test('no dash: artist comes from the channel ("- Topic", "...VEVO")', () => {
    assert.deepEqual(first('Major Tom (Coming Home)', 'Peter Schilling - Topic'), { artist: 'Peter Schilling', track: 'Major Tom (Coming Home)' });
    assert.deepEqual(first('Don\'t You (Forget About Me) (Official Video)', 'SimpleMindsVEVO'), { artist: 'Simple Minds', track: 'Don\'t You (Forget About Me)' });
  });

  test('also tries without "feat." and with the channel as artist', () => {
    const all = plain(L.yhdxParseVideoTitle('Artist - Song feat. Guest (Official Video)', 'ArtistVEVO'));
    assert.deepEqual(all.map((c) => c.track), ['Song feat. Guest', 'Song']);
    assert.ok(all.length <= 3);
  });

  test('gives up on titles it cannot read', () => {
    assert.equal(L.yhdxParseVideoTitle('', '').length, 0);
  });
});

// ---------------------------------------------------------------- parsing

describe('LRC and SRT', () => {
  test('LRC becomes timed cues; blank lines end a line; repeated stamps repeat it', () => {
    const cues = plain(L.yhdxParseLrc(LRC, 200));
    assert.deepEqual(cues[0], { start: 12.5, end: 16, text: 'Ground control to Major Tom' });
    assert.deepEqual(cues[1], { start: 16, end: 20.25, text: 'Commencing countdown, engines on' }); // ends at the blank line
    assert.deepEqual(cues.map((c) => c.start), [12.5, 16, 62.1, 150]);
    assert.equal(cues[2].end, 62.1 + 8); // held at most 8 s
    assert.equal(cues[3].end, 156);      // last line: 6 s
  });

  test('LRC never runs past the end of the video', () => {
    const cues = L.yhdxParseLrc('[00:58.00] last line', 60);
    assert.equal(cues[0].end, 60);
  });

  test('SRT with tags', () => {
    const cues = plain(L.yhdxParseSrt('1\r\n00:00:12,500 --> 00:00:16,000\r\n<i>Ground control</i>\r\n\r\n2\n00:01:02.100 --> 00:01:05.000\nline two\n'));
    assert.deepEqual(cues, [{ start: 12.5, end: 16, text: 'Ground control' }, { start: 62.1, end: 65, text: 'line two' }]);
  });
});

// ---------------------------------------------------------------- matching

describe('only lyrics whose timing lines up', () => {
  const r = (duration, extra = {}) => ({ duration, syncedLyrics: LRC, instrumental: false, trackName: 't', artistName: 'a', ...extra });

  test('picks the closest length within 3 s', () => {
    assert.equal(L.yhdxPickLrclib([r(240), r(301.5), r(299)], 300).duration, 299);
  });

  test('rejects lengths more than 3 s off (e.g. a video with a long intro)', () => {
    assert.equal(L.yhdxPickLrclib([r(280), r(320)], 300), null);
  });

  test('skips instrumentals and plain (unsynced) lyrics', () => {
    assert.equal(L.yhdxPickLrclib([r(300, { instrumental: true }), r(300, { syncedLyrics: null })], 300), null);
  });

  test('OpenSubtitles lines must fit inside the video', () => {
    const cue = (start, end) => ({ start, end, text: 'x' });
    assert.equal(L.yhdxSubsFitVideo([cue(10, 20), cue(200, 250)], 260), true);
    assert.equal(L.yhdxSubsFitVideo([cue(10, 20), cue(400, 410)], 260), false); // runs past the end: a different cut
    assert.equal(L.yhdxSubsFitVideo([cue(10, 20), cue(30, 40)], 260), false);   // covers too little: wrong file
  });
});

// ---------------------------------------------------------------- sources

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => String(body) });
const VIDEO = { title: 'Peter Schilling - Major Tom (Coming Home) (Official Video)', author: 'Peter Schilling', duration: 300 };

describe('finding lyrics', () => {
  test('LRCLIB hit', async () => {
    const urls = [];
    const fetchFn = async (url) => { urls.push(url); return json([{ duration: 299.4, syncedLyrics: LRC, instrumental: false, trackName: 'Major Tom', artistName: 'Peter Schilling' }]); };
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn });
    assert.equal(res.source, 'LRCLIB');
    assert.equal(res.cues[0].text, 'Ground control to Major Tom');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/lrclib\.net\/api\/search\?artist_name=Peter%20Schilling&track_name=Major%20Tom%20\(Coming%20Home\)$/);
  });

  test('timing mismatch everywhere: no lyrics, remembered as not found', async () => {
    const fetchFn = async () => json([{ duration: 250, syncedLyrics: LRC, instrumental: false }]);
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn });
    assert.equal(res.cues, null);
    assert.equal(res.retryable, false);
  });

  test('LRCLIB down: no lyrics now, but retryable', async () => {
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn: async () => json('Bad gateway', 502) });
    assert.equal(res.cues, null);
    assert.equal(res.retryable, true);
    const res2 = await L.yhdxFindLyrics(VIDEO, { fetchFn: async () => { throw new Error('offline'); } });
    assert.equal(res2.retryable, true);
  });

  test('OpenSubtitles is never called without an API key', async () => {
    const urls = [];
    await L.yhdxFindLyrics(VIDEO, { fetchFn: async (url) => { urls.push(url); return json([]); } });
    assert.ok(urls.every((u) => u.startsWith('https://lrclib.net/')));
  });

  test('OpenSubtitles fallback: search, download, fits the video', async () => {
    const calls = [];
    const srt = '1\n00:00:12,000 --> 00:00:15,000\nGround control\n\n2\n00:04:00,000 --> 00:04:05,000\nfar above the moon\n';
    const fetchFn = async (url, init) => {
      calls.push({ url, method: init?.method || 'GET', key: init?.headers?.['Api-Key'] });
      if (url.startsWith('https://lrclib.net/')) return json([]);
      if (url.includes('/subtitles?')) return json({ data: [{ attributes: { feature_details: { title: 'Major Tom (Coming Home)' }, files: [{ file_id: 42 }] } }] });
      if (url.endsWith('/download')) { assert.equal(JSON.parse(init.body).file_id, 42); return json({ link: 'https://dl.opensubtitles.org/x.srt' }); }
      if (url === 'https://dl.opensubtitles.org/x.srt') return json(srt);
      throw new Error('unexpected ' + url);
    };
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn, openSubtitlesKey: 'KEY' });
    assert.equal(res.source, 'OpenSubtitles');
    assert.equal(res.cues.length, 2);
    assert.ok(calls.filter((c) => c.url.includes('opensubtitles.com')).every((c) => c.key === 'KEY'));
    assert.equal(calls.find((c) => c.url.endsWith('/download')).method, 'POST');
  });

  test('OpenSubtitles results for a different title are not used', async () => {
    let downloaded = false;
    const fetchFn = async (url) => {
      if (url.startsWith('https://lrclib.net/')) return json([]);
      if (url.includes('/subtitles?')) return json({ data: [{ attributes: { feature_details: { title: 'Space Movie' }, files: [{ file_id: 7 }] } }] });
      downloaded = true; return json({});
    };
    const res = await L.yhdxFindLyrics(VIDEO, { fetchFn, openSubtitlesKey: 'KEY' });
    assert.equal(res.cues, null);
    assert.equal(downloaded, false); // a download would cost the daily quota
  });
});

// ---------------------------------------------------------------- service worker cache

describe('lyrics lookups are cached', () => {
  test('found: second ask does not hit the network', async () => {
    let n = 0;
    const bg = loadPlayerBackground({ fetchFn: async () => { n++; return json([{ duration: 300, syncedLyrics: LRC, instrumental: false }]); } });
    const a = await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    const b = await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    assert.equal(a.source, 'LRCLIB');
    assert.deepEqual(plain(a), plain(b));
    assert.equal(n, 1);
  });

  test('site down: tried again after an hour, not a week', async () => {
    let now = 1_000_000;
    let n = 0;
    const bg = loadPlayerBackground({ now: () => now, fetchFn: async () => { n++; return json('down', 503); } });
    await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    assert.equal(n, 1);
    now += 61 * 60 * 1000;
    await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    assert.equal(n, 2);
  });

  test('uses the OpenSubtitles key saved on this PC', async () => {
    const seen = [];
    const bg = loadPlayerBackground({ openSubtitlesKey: 'LOCALKEY', fetchFn: async (url, init) => { seen.push(init?.headers?.['Api-Key']); return json(url.includes('lrclib') ? [] : { data: [] }); } });
    await bg.ask({ videoId: 'wO0A0XcWy88', ...VIDEO });
    assert.ok(seen.includes('LOCALKEY'));
  });

  test('ignores junk video ids', async () => {
    const bg = loadPlayerBackground({ fetchFn: async () => { throw new Error('should not fetch'); } });
    assert.equal((await bg.ask({ videoId: '../../etc', ...VIDEO })).cues, null);
  });
});

// ---------------------------------------------------------------- bridge

describe('bridge between page and service worker', () => {
  test('forwards a lyrics request and hands the cues back to the page', async () => {
    const sent = [];
    const posted = await runBridge({}, { lyricsReply: { cues: [{ start: 1, end: 2, text: 'hi' }], source: 'LRCLIB' }, onSend: (m) => sent.push(m) });
    await posted.receive({ __yhdx: 'lyrics-request', videoId: 'wO0A0XcWy88', title: 'A - B', author: 'A', duration: 200 });
    assert.deepEqual(plain(sent[0]), { type: 'lyrics', videoId: 'wO0A0XcWy88', title: 'A - B', author: 'A', duration: 200, exclude: [] });
    const reply = posted.find((p) => p.__yhdx === 'lyrics');
    assert.equal(reply.videoId, 'wO0A0XcWy88');
    assert.equal(reply.cues[0].text, 'hi');
  });
});

// ---------------------------------------------------------------- on the page

describe('lyrics on the page', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  const autoEn = { languageCode: 'en', kind: 'asr', vss_id: 'a.en' };
  const manualEn = { languageCode: 'en', kind: '', vss_id: '.en' };
  const CUES = [{ start: 12.5, end: 16, text: 'Ground control to Major Tom' }, { start: 16, end: 20, text: 'Commencing countdown' }];
  const requests = (page) => page.posted.filter((m) => m.__yhdx === 'lyrics-request');

  function noCaptionsVideo(over = {}, tracks = [autoEn]) {
    const page = createYoutubePage({ player: new FakePlayer({ tracks }) });
    page.sendSettings(settings({ forceQuality: false, ...over }));
    advance(600);
    return page;
  }

  test('asks for lyrics when only auto-generated captions exist', () => {
    const page = noCaptionsVideo();
    const req = plain(requests(page));
    assert.equal(req.length, 1);
    assert.deepEqual(req[0], { __yhdx: 'lyrics-request', videoId: 'vid1', title: 'Peter Schilling - Major Tom (Coming Home) (Official Video)', author: 'Peter Schilling', duration: 300, exclude: [] });
  });

  test('asks for lyrics when the video has no captions at all', () => {
    const page = noCaptionsVideo({}, []);
    advance(8000); // waits for the caption list first
    assert.equal(requests(page).length, 1);
  });

  test('does not ask when proper English captions exist', () => {
    const page = noCaptionsVideo({}, [manualEn]);
    advance(5000);
    assert.equal(requests(page).length, 0);
  });

  test('does not ask when the switch is off or captions are set to off', () => {
    assert.equal(requests(noCaptionsVideo({ lyricsWhenNoCaptions: false })).length, 0);
    assert.equal(requests(noCaptionsVideo({ captions: 'off' })).length, 0);
  });

  test('shows the right line at the right time, in the caption style class', () => {
    const page = noCaptionsVideo();
    page.sendLyrics('vid1', CUES);
    const win = page.lyricsWindow();
    const span = win.children[0];
    assert.match(span.className, /\bytp-caption-segment\b/); // so the user's yellow outlined style applies

    page.player.time = 5; advance(300);
    assert.equal(win.style.display, 'none');
    page.player.time = 13; advance(300);
    assert.equal(span.textContent, 'Ground control to Major Tom');
    assert.equal(win.style.display, '');
    page.player.time = 17; advance(300);
    assert.equal(span.textContent, 'Commencing countdown');
    page.player.time = 25; advance(300);
    assert.equal(win.style.display, 'none');
  });

  test('hides during ads and when YouTube shows its own captions', () => {
    const page = noCaptionsVideo();
    page.sendLyrics('vid1', CUES);
    page.player.time = 13;
    page.player.ad = true; advance(300);
    assert.equal(page.lyricsWindow().style.display, 'none');
    page.player.ad = false; page.youtubeCaptionsShowing = true; advance(300);
    assert.equal(page.lyricsWindow().style.display, 'none');
    page.youtubeCaptionsShowing = false; advance(300);
    assert.equal(page.lyricsWindow().style.display, '');
  });

  test('ignores lyrics for another video, and removes them when the video changes', () => {
    const page = noCaptionsVideo();
    page.sendLyrics('otherVideo', CUES);
    assert.equal(page.lyricsWindow(), undefined);
    page.sendLyrics('vid1', CUES);
    assert.ok(page.lyricsWindow());
    page.player.videoId = 'vid2';
    advance(500);
    assert.equal(page.lyricsWindow(), undefined);
  });

  test('turning the switch off removes them', () => {
    const page = noCaptionsVideo();
    page.sendLyrics('vid1', CUES);
    page.sendSettings(settings({ forceQuality: false, lyricsWhenNoCaptions: false }));
    assert.equal(page.lyricsWindow(), undefined);
  });

  test('asks only once per video', () => {
    const page = noCaptionsVideo();
    page.fireVideoLoaded();
    page.fireWindow('yt-navigate-finish');
    advance(3000);
    assert.equal(requests(page).length, 1);
  });
});
