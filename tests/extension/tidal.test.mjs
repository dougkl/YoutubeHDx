// Run: node --test tests/extension/tidal.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadTidal } from './harness.mjs';

const T = loadTidal();
const track = (id, title, version, seconds, artists, mediaTags = ['LOSSLESS']) => ({ id, title, version, seconds, artists, mediaTags });

describe('same recording on TIDAL', () => {
  test('plain song: noise in the video title does not matter, length must agree within 2 s', () => {
    const v = T.yhdxSongParse('The Beatles - Let It Be (Official Music Video)', 'TheBeatlesVEVO');
    const tracks = [
      track('1', 'Let It Be', 'Live', 243, ['The Beatles']),
      track('2', 'Let It Be', 'Remastered 2009', 243.5, ['The Beatles']),
      track('3', 'Let It Be', null, 243, ['A Cover Band'], ['HIRES_LOSSLESS']),
      track('4', 'Let It Be', null, 263, ['The Beatles'], ['HIRES_LOSSLESS']),
    ];
    assert.equal(T.yhdxTidalPick(v, 242.8, tracks).id, '2');
    assert.equal(T.yhdxTidalPick(v, 250, tracks), null);
  });

  test('versions: live shows, named mixes and cuts must match', () => {
    const same = (title, t) => T.yhdxTidalSameSong(T.yhdxSongParse(title), t);
    assert.equal(same('The Who - Pinball Wizard (Live at the Isle of Wight, 1970)', track('1', 'Pinball Wizard', 'Live At Leeds/1970', 1, ['The Who'])), false);
    assert.equal(same('Eric Johnson - Cliffs Of Dover - Live', track('1', 'Cliffs of Dover', 'Live', 1, ['Eric Johnson'])), true);
    assert.equal(same('The Doors - Love Me Two Times (Single Mix)', track('1', 'Love Me Two Times', 'Atmos Mix', 1, ['The Doors'])), false);
    assert.equal(same('Alice DJ - Better Off Alone (Official Video)', track('1', 'Better Off Alone', 'UK Short Cut', 1, ['Alice DJ'])), false);
    assert.equal(same('Def Leppard - Hysteria', track('1', 'Hysteria', 'Long Version', 1, ['Def Leppard'])), false);
  });

  test('several TIDAL artists, feat. guests, reversed names, channel as artist', () => {
    const same = (title, t, author) => T.yhdxTidalSameSong(T.yhdxSongParse(title, author), t);
    assert.equal(same('AronChupa & Little Sis Nora - Hole in the Roof (Official Music Video)', track('1', 'Hole in the Roof', null, 1, ['AronChupa', 'Little Sis Nora'])), true);
    assert.equal(same('Fatboy Slim ft. Bootsy Collins - Weapon Of Choice', track('1', 'Weapon Of Choice', 'Remastered', 1, ['Fatboy Slim', 'Bootsy Collins'])), true);
    assert.equal(same('Oh, Pretty Woman - Roy Orbison', track('1', 'Oh, Pretty Woman', null, 1, ['Roy Orbison'])), true);
    assert.equal(same("Don't You (Forget About Me)", track('1', "Don't You (Forget About Me)", null, 1, ['Simple Minds']), 'SimpleMindsVEVO'), true);
  });

  test('ISO 8601 lengths', () => {
    assert.equal(T.yhdxIsoSeconds('PT2M58S'), 178);
    assert.equal(T.yhdxIsoSeconds('PT1H2M5.5S'), 3725.5);
    assert.equal(T.yhdxIsoSeconds('x'), 0);
  });
});

describe('search through the official API', () => {
  const api = (routes) => {
    const urls = [];
    const fetchFn = async (url, init) => {
      urls.push(decodeURIComponent(url));
      assert.equal(init.headers.Authorization, 'Bearer tok');
      for (const [re, body] of routes) if (re.test(decodeURIComponent(url))) return { ok: true, status: 200, json: async () => body };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    return { fetchFn, urls };
  };

  test('finds the same-length track, with artist names from the included resources', async () => {
    const { fetchFn, urls } = api([
      [/searchResults\?filter\[query\]=pink floyd learning to fly/, { data: [{ id: 'q', type: 'searchResults', relationships: { tracks: { data: [{ id: '7', type: 'tracks' }, { id: '8', type: 'tracks' }] } } }] }],
      [/\/tracks\?filter\[id\]=7&filter\[id\]=8/, {
        data: [
          { id: '7', type: 'tracks', attributes: { title: 'Learning To Fly', version: 'Live', duration: 'PT4M53S', mediaTags: ['LOSSLESS'] }, relationships: { artists: { data: [{ id: 'a1', type: 'artists' }] } } },
          { id: '8', type: 'tracks', attributes: { title: 'Learning To Fly', version: '2019 Remix', duration: 'PT4M52S', mediaTags: ['HIRES_LOSSLESS'] }, relationships: { artists: { data: [{ id: 'a1', type: 'artists' }] } } },
        ],
        included: [{ id: 'a1', type: 'artists', attributes: { name: 'Pink Floyd' } }],
      }],
    ]);
    // the video is the plain song: neither the live nor the remix may be used
    const r = await T.yhdxTidalFind({ title: 'Pink Floyd - Learning To Fly (Official Music Video HD)', author: 'Pink Floyd', duration: 292.4 }, { fetchFn, token: 'tok' });
    assert.equal(r.track, null);
    assert.match(urls[0], /countryCode=US&include=tracks/);
  });

  test('asks whether a track plays in full or only as a preview', async () => {
    const answer = (presentation, ok = true) => async () => ({ ok, status: ok ? 200 : 403, json: async () => ({ data: { attributes: { trackPresentation: presentation } } }) });
    assert.equal(await T.yhdxTidalPresentation('9', { fetchFn: answer('FULL'), token: 'tok' }), 'FULL');
    assert.equal(await T.yhdxTidalPresentation('9', { fetchFn: answer('PREVIEW'), token: 'tok' }), 'PREVIEW');
    assert.equal(await T.yhdxTidalPresentation('9', { fetchFn: answer('FULL', false), token: 'tok' }), null, 'unknown: let the player find out');
    assert.equal(await T.yhdxTidalPresentation('9', { fetchFn: async () => { throw new Error('offline'); }, token: 'tok' }), null);
    assert.equal(await T.yhdxTidalPresentation('9/../x', { fetchFn: answer('FULL'), token: 'tok' }), null);
  });

  test('skips tracks you said are wrong', async () => {
    const { fetchFn } = api([
      [/searchResults/, { data: [{ relationships: { tracks: { data: [{ id: '9' }] } } }] }],
      [/\/tracks\?/, { data: [{ id: '9', attributes: { title: 'Angels', duration: 'PT4M24S' }, relationships: { artists: { data: [{ id: 'r' }] } } }], included: [{ id: 'r', type: 'artists', attributes: { name: 'Robbie Williams' } }] }],
    ]);
    const v = { title: 'Robbie Williams - Angels', author: 'Robbie Williams', duration: 264.4 };
    assert.equal((await T.yhdxTidalFind(v, { fetchFn, token: 'tok' })).track.id, '9');
    assert.equal((await T.yhdxTidalFind(v, { fetchFn, token: 'tok', exclude: ['9'] })).track, null);
  });
});

describe('keeping TIDAL in step with the video', () => {
  test('in step: same speed', () => assert.deepEqual({ ...T.yhdxSyncStep(10.01, 10) }, { seek: null, rate: 1 }));
  test('a little ahead: plays slightly slower', () => {
    const s = T.yhdxSyncStep(10.1, 10);
    assert.equal(s.seek, null);
    assert.ok(s.rate < 1 && s.rate >= 0.96);
  });
  test('a little behind: slightly faster', () => assert.ok(T.yhdxSyncStep(9.9, 10).rate > 1));
  test('far off (you seeked): jumps', () => assert.equal(T.yhdxSyncStep(3, 60).seek, 60));
  test('follows the video speed', () => assert.equal(T.yhdxSyncStep(10, 10, 1.5).rate, 1.5));
});

describe('sign-in', () => {
  test('PKCE challenge is the SHA-256 of the verifier', async () => {
    const p = await T.yhdxPkce();
    const expected = createHash('sha256').update(p.verifier).digest('base64url');
    assert.equal(p.challenge, expected);
    const url = T.yhdxTidalAuthorizeUrl('cid', 'https://abc.chromiumapp.org/tidal', p);
    assert.match(url, /scope=search\.read%20playback%20user\.read/);
    assert.match(url, /redirect_uri=https%3A%2F%2Fabc\.chromiumapp\.org%2Ftidal/);
  });
});
