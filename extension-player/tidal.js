// TIDAL audio for music videos: find the same recording at the same length on TIDAL, and keep TIDAL's audio in
// step with the YouTube video. Pure functions (no chrome.* here) so they can be tested; background.js does the
// sign-in, caching and messaging, offscreen.js plays the audio.
// The "same song" rules are the downloader's (SongKey.cs): a live, remix, mix, cover... is never the plain song, two
// live versions must be the same show, and the lengths must agree. One exception for TIDAL: a radio edit / single
// version is the same recording cut shorter, and counts when its length matches the video's.

const YHDX_TIDAL_API = 'https://openapi.tidal.com/v2';
const YHDX_TIDAL_TOLERANCE_S = 2;     // TIDAL track length must be within this of the video's
const YHDX_TIDAL_MANUAL_S = 20;       // otherwise you may still pick TIDAL's version if it's this close (you sync it;
                                      // the Player offers up to 10 s off, and asks before 10-20 s)

// ---------------------------------------------------------------- song names

const YHDX_MARKERS = /\b(live|acoustic|unplugged|remix|rmx|mix|cover|demo|extended|long|edit|instrumental|karaoke|version|stereo|mono|concert|session|tour|totp|top of the pops|reprise|medley|mashup|parody|tribute|orchestral|symphonic|a ?cappella|rehearsal|bootleg|dub|reggae|slowed|sped up|nightcore|pt|part|cut|short|radio)\b/g;
const YHDX_PLAIN_VERSION = /\b(official|video|music video|official video|hd|original) version\b/g;
const YHDX_NOISE = /\b(official|officiel|video|videoclip|clip|music|audio|hd|hq|uhd|4k|8k|1080p|720p|480p|remastered|remaster|original|widescreen|lyrics?|mv|promo|film|vod|full|high quality)\b/g;
const YHDX_SMALL = new Set(['at', 'the', 'of', 'in', 'from', 'a', 'an', 'and', 'on', 'for', 'with', 'to', 'by', 's']);

/** Lowercase, no accents, straight quotes, "&" as "and". */
function yhdxFold(s) {
  return String(s ?? '').replace(/[’‘´]/g, "'").replace(/&/g, ' and ').replace(/\+/g, ' and ')
    .normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
}

/** The bare name: no brackets, years, "official video" words, version words, feat., punctuation or leading "the". */
function yhdxSongNorm(part) {
  let t = yhdxFold(part);
  t = t.replace(/\s*\b(feat\.?|ft\.?|featuring)\s.*$/, '');
  t = t.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  t = t.replace(/\b(19|20)\d{2}\b/g, ' ');
  t = t.replace(YHDX_PLAIN_VERSION, ' ').replace(YHDX_NOISE, ' ').replace(YHDX_MARKERS, ' ');
  t = t.replace(/'/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (t.startsWith('the ')) t = t.slice(4);
  return t;
}

function yhdxCleanChannel(author) {
  let a = String(author || '').trim();
  if (/\s*-\s*Topic$/i.test(a)) return a.replace(/\s*-\s*Topic$/i, '').trim();
  if (/VEVO$/.test(a)) a = a.replace(/VEVO$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return a.trim();
}

/** {artist, track, kind, markers, raw} from a video title (and the channel, when the title has no artist). */
function yhdxSongParse(title, artistHint) {
  const raw = String(title || '').trim();
  const low = yhdxFold(raw);
  const kind = /\blyrics?\b/.test(low) ? 'lyrics' : /\b(official )?audio\b|\bvisuali[sz]er\b/.test(low) ? 'audio' : 'video';
  const markers = {};
  for (const m of low.replace(YHDX_PLAIN_VERSION, ' ').matchAll(YHDX_MARKERS)) {
    const w = m[0].replace(/ /g, '');
    markers[w] = (markers[w] || 0) + 1;
  }
  let artist = '';
  let track = '';
  const parts = raw.split(/\s+[-–—~]\s*|\s*[-–—~]\s+|\s*~\s*|\s{3,}/);
  if (parts.length >= 2 && yhdxSongNorm(parts[0]) && yhdxSongNorm(parts.slice(1).join(' - '))) {
    artist = yhdxSongNorm(parts[0]);
    track = yhdxSongNorm(parts.slice(1).join(' - '));
  } else if ((raw.match(/-/g) || []).length === 1 && raw.indexOf('-') > 0 && raw.slice(0, raw.indexOf('-')).trim().includes(' ')
             && yhdxSongNorm(raw.slice(raw.indexOf('-') + 1))) {
    artist = yhdxSongNorm(raw.slice(0, raw.indexOf('-')));        // "Pharrell Williams-Happy"
    track = yhdxSongNorm(raw.slice(raw.indexOf('-') + 1));
  } else {
    artist = artistHint ? yhdxSongNorm(yhdxCleanChannel(artistHint)) : '';
    track = yhdxSongNorm(raw);
  }
  return { artist, track, kind, markers, raw };
}

function yhdxSimilarity(a, b) {
  if (a === b) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** What the version words are about: "Live at Leeds" -> {leeds}. */
function yhdxDetails(s) {
  let t = yhdxFold(s.raw).replace(/'/g, '');
  t = t.replace(/\b(feat\.?|ft\.?|featuring|with)\s[^()[\]{}\-–—]*/g, ' ');
  t = t.replace(/\b(19|20)\d{2}\b/g, ' ').replace(YHDX_PLAIN_VERSION, ' ').replace(YHDX_NOISE, ' ').replace(YHDX_MARKERS, ' ');
  const words = new Set(t.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  for (const w of `${s.artist} ${s.track}`.split(' ').filter(Boolean)) { words.delete(w); words.delete(`${w}s`); }
  for (const w of [...words]) if (YHDX_SMALL.has(w) || w.length === 1 || (/^\d+$/.test(w) && w.length <= 2)) words.delete(w);
  return words;
}

const yhdxSameMarkers = (a, b) => {
  const ka = Object.keys(a.markers);
  return ka.length === Object.keys(b.markers).length && ka.every((k) => b.markers[k] === a.markers[k]);
};

/** True if the names say it's the same recording (lengths are checked separately). */
function yhdxSameRecording(a, b) {
  if (!a.track || !b.track || !a.artist || !b.artist || !yhdxSameMarkers(a, b)) return false;
  const sameNames = (a.artist === b.artist && a.track === b.track) || (a.artist === b.track && a.track === b.artist);
  if (!sameNames) return false;
  if (Object.keys(a.markers).length) {
    const da = yhdxDetails(a);
    const db = yhdxDetails(b);
    if (!da.size !== !db.size) return false; // both "live", only one says which show
    if (da.size && db.size && ![...da].some((w) => db.has(w)) && yhdxSimilarity([...da].join(' '), [...db].join(' ')) < 0.8) return false;
  }
  return true;
}

// A music video is often the radio edit / single version of the song. Those words alone don't make another
// recording, only a shorter cut of it; the length check (within 2 s) tells which cut. Live, remix, extended, a
// language ("Spanish Version") or "clean" still never count.
const YHDX_CUT_MARKERS = new Set(['radio', 'edit', 'cut', 'short', 'version']);
const YHDX_CUT_DETAILS = new Set(['single', 'video', 'album']);
function yhdxOnlyCut(s) {
  const k = Object.keys(s.markers);
  return k.length > 0 && k.every((m) => YHDX_CUT_MARKERS.has(m)) && [...yhdxDetails(s)].every((w) => YHDX_CUT_DETAILS.has(w));
}
const yhdxUncut = (s) => ({ ...s, markers: {} });

/** Does this TIDAL track ({title, version, artists}) name the same recording as the video? */
function yhdxTidalSameSong(video, track) {
  const artists = track.artists || [];
  const names = [...new Set([...artists, ...(artists.length > 1 ? [artists.join(' & '), artists.join(', ')] : [])])];
  const full = track.version ? `${track.title} (${track.version})` : track.title;
  const plain = (s) => !Object.keys(s.markers).length;
  return names.some((artist) => {
    const t = { ...yhdxSongParse(`${artist} - ${full}`), kind: video.kind };
    if (yhdxSameRecording(video, t)) return true;
    if (plain(video) && yhdxOnlyCut(t)) return yhdxSameRecording(video, yhdxUncut(t));
    if (plain(t) && yhdxOnlyCut(video)) return yhdxSameRecording(yhdxUncut(video), t);
    return false;
  });
}

/** The same recording at the same length (best: Hi-Res / lossless, then closest length) or null. */
function yhdxTidalPick(video, videoSeconds, tracks) {
  let best = null;
  const rank = (t) => (t.mediaTags?.includes('HIRES_LOSSLESS') ? 2 : t.mediaTags?.includes('LOSSLESS') ? 1 : 0);
  for (const t of tracks) {
    if (!(t.seconds > 0) || !(videoSeconds > 0) || t.streamable === false || !yhdxTidalSameSong(video, t)) continue;
    const diff = Math.abs(t.seconds - videoSeconds);
    if (diff > YHDX_TIDAL_TOLERANCE_S) continue;
    const bestDiff = best ? Math.abs(best.seconds - videoSeconds) : Infinity;
    // Lossless / Hi-Res first among the ones within 2 s (a lossy copy 0 s off loses to a lossless one 2 s off:
    // the sync file or the sync loop takes care of the difference), then the closest length.
    if (!best || rank(t) > rank(best) || (rank(t) === rank(best) && diff < bestDiff)) best = t;
  }
  return best;
}

/** "PT3M45S" -> 225 */
function yhdxIsoSeconds(iso) {
  const m = /^P(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)$/.exec(String(iso || ''));
  return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
}

// ---------------------------------------------------------------- TIDAL search (official API)

async function yhdxTidalGet(path, { fetchFn, token }) {
  const r = await fetchFn(YHDX_TIDAL_API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' } });
  if (r.status === 401) throw Object.assign(new Error('TIDAL sign-in expired'), { status: 401 });
  if (!r.ok) throw Object.assign(new Error(`TIDAL answered ${r.status}`), { status: r.status, retryable: r.status === 429 || r.status >= 500 });
  return r.json();
}

/** Tracks for a search, with artists, length and quality tags. */
async function yhdxTidalSearch(query, { fetchFn, token, country = 'US', max = 10 }) {
  const q = encodeURIComponent(String(query).slice(0, 250));
  const res = await yhdxTidalGet(`/searchResults?filter[query]=${q}&countryCode=${country}&include=tracks`, { fetchFn, token });
  const ids = [];
  for (const r of [].concat(res?.data || [])) for (const t of r?.relationships?.tracks?.data || []) ids.push(String(t.id));
  if (!ids.length) return [];
  const pick = ids.slice(0, Math.min(max, 20));
  const filter = pick.map((id) => `filter[id]=${encodeURIComponent(id)}`).join('&');
  const doc = await yhdxTidalGet(`/tracks?${filter}&countryCode=${country}&include=artists`, { fetchFn, token });
  const names = new Map((doc?.included || []).filter((x) => x.type === 'artists').map((x) => [String(x.id), x.attributes?.name || '']));
  const byId = new Map((doc?.data || []).map((t) => [String(t.id), {
    id: String(t.id),
    title: t.attributes?.title || '',
    version: t.attributes?.version || null,
    seconds: yhdxIsoSeconds(t.attributes?.duration),
    mediaTags: t.attributes?.mediaTags || [],
    // TIDAL lists what a track may be used for (STREAM, DJ, STEM); one without STREAM can't be played
    // ("Sorry, this content is currently unavailable" in TIDAL's player). No list: assume it plays.
    streamable: !Array.isArray(t.attributes?.availability) || t.attributes.availability.includes('STREAM'),
    artists: (t.relationships?.artists?.data || []).map((a) => names.get(String(a.id))).filter(Boolean),
  }]));
  return pick.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The TIDAL track to play with this video, or null. {title, author, duration} come from YouTube's player.
 * Result: {track, query} or {track: null, reason}.
 */
async function yhdxTidalFind({ title, author, duration }, { fetchFn, token, country = 'US', exclude = [] }) {
  const video = yhdxSongParse(title, author);
  if (!video.artist || !video.track) return { track: null, reason: 'no artist and song in the title' };
  if (!(duration > 0)) return { track: null, reason: 'video length unknown' };
  const queries = [...new Set([`${video.artist} ${video.track}`, `${yhdxCleanChannel(author)} ${video.track}`].map((q) => q.trim()).filter(Boolean))];
  const sameSong = new Set(); // lengths of TIDAL's versions of this song, to explain a miss
  let nearest = null;         // the closest of them, if within YHDX_TIDAL_MANUAL_S: offered in the ⇄ menu
  for (const query of queries) {
    const tracks = (await yhdxTidalSearch(query, { fetchFn, token, country })).filter((t) => !exclude.includes(t.id));
    const track = yhdxTidalPick(video, duration, tracks);
    if (track) return { track, query };
    for (const t of tracks) {
      if (!(t.seconds > 0) || !yhdxTidalSameSong(video, t)) continue;
      sameSong.add(Math.round(t.seconds));
      const diff = Math.abs(t.seconds - duration);
      if (t.streamable !== false && diff <= YHDX_TIDAL_MANUAL_S && (!nearest || diff < Math.abs(nearest.seconds - duration))) nearest = t;
    }
  }
  if (!sameSong.size) return { track: null, reason: 'song not found on TIDAL' };
  const mmss = (x) => { const s = Math.round(x); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  return { track: null, reason: 'no same-length recording on TIDAL', ...(nearest ? { nearest } : {}),
           lengths: `video ${mmss(duration)}; TIDAL has ${[...sameSong].sort((a, b) => a - b).map(mmss).join(', ')}` };
}

/**
 * Does TIDAL play this track in full for this app and account, or only a 30-second preview? Asked before YouTube's
 * sound is muted, so a song that only has a preview simply keeps YouTube's sound. 'FULL' | 'PREVIEW' | null (unknown).
 */
async function yhdxTidalPresentation(trackId, { fetchFn, token, country = 'US' }) {
  if (!/^\d{1,15}$/.test(String(trackId))) return null;
  const q = new URLSearchParams([['adaptive', 'true'], ['formats', 'FLAC'], ['formats', 'AACLC'], ['manifestType', 'MPEG_DASH'],
    ['uriScheme', 'HTTPS'], ['usage', 'PLAYBACK'], ['countryCode', country]]);
  try {
    const r = await fetchFn(`${YHDX_TIDAL_API}/trackManifests/${trackId}?${q}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' } });
    if (!r.ok) return null;
    const p = (await r.json())?.data?.attributes?.trackPresentation;
    return p === 'FULL' || p === 'PREVIEW' ? p : null;
  } catch {
    return null;
  }
}

/**
 * yhdxTidalFind, then make sure TIDAL plays it in full; if only a preview, try one other same-length recording.
 * Some songs play in full, some only as a preview: the answer is per song.
 */
async function yhdxTidalFindPlayable(video, opts) {
  const previews = [];
  let found = null;
  for (let i = 0; i < 2; i++) {
    found = await yhdxTidalFind(video, { ...opts, exclude: [...(opts.exclude ?? []), ...previews.map((t) => t.id)] });
    if (!found.track) break;
    if ((await yhdxTidalPresentation(found.track.id, opts)) !== 'PREVIEW') return found;
    previews.push(found.track);
  }
  if (previews.length) return { track: null, preview: true, previewTrack: previews[0], reason: 'TIDAL has only a 30-second preview of this song' };
  return found;
}

// ---------------------------------------------------------------- keeping the audio in step

/**
 * One step of the sync loop. `target` is where TIDAL should be (video time + your offset), `audio` where it is.
 * Big gaps jump; small ones are closed by playing a little faster or slower, which you can't hear.
 * Returns {seek: seconds|null, rate}.
 */
function yhdxSyncStep(audio, target, videoRate = 1) {
  const drift = audio - target;                        // > 0: TIDAL is ahead
  if (Math.abs(drift) > 0.35) return { seek: Math.max(0, target), rate: videoRate };
  if (Math.abs(drift) <= 0.02) return { seek: null, rate: videoRate };
  const correction = Math.max(-0.04, Math.min(0.04, drift * 0.5)); // close the gap in ~2 s, at most 4% off speed
  return { seek: null, rate: videoRate * (1 - correction) };
}

const yhdxScale = (x) => { const n = Number(x); return n > 0.9 && n < 1.1 ? n : 1; };

/**
 * Where TIDAL should be now. `k` is the video's clock {videoTime, playing, sentAt, rate, offset, scale}: TIDAL time =
 * video time x scale + offset. The scale is the speed difference the sync file measured (e.g. 0.999 for a video
 * transferred at NTSC speed); without one it's 1, as before.
 */
function yhdxSyncTarget(k, now = Date.now()) {
  const video = k.videoTime + (k.playing ? ((now - k.sentAt) / 1000) * k.rate : 0);
  return video * yhdxScale(k.scale) + (k.offset || 0);
}

/** TIDAL's playing speed for the video's: the video's speed x the measured scale. */
function yhdxSyncRate(k) {
  return (Number(k.rate) || 1) * yhdxScale(k.scale);
}

// ---------------------------------------------------------------- the published sync file

const YHDX_SYNC_FILE_URL = 'https://raw.githubusercontent.com/dougkl/YoutubeHDx/main/sync/tidal-sync.json';

/**
 * This video's entry in the sync file (tools/tidalsync measures them; sync/tidal-sync.json in the repo), or null.
 * {status: 'ok', tidal, offset, scale, stamp} or {status: 'keep-youtube', reason}. Anything malformed is ignored.
 */
function yhdxSyncEntry(file, videoId) {
  if (!file || file.format !== 1 || !file.videos || typeof file.videos !== 'object') return null;
  const e = file.videos[videoId];
  if (!e || typeof e !== 'object') return null;
  if (e.status === 'keep-youtube') return { status: 'keep-youtube', reason: String(e.reason || '') };
  if (e.status === 'segments') {
    // A video edited differently from TIDAL's song: [from video s, offset or null (TIDAL has nothing there), scale].
    const tidal = String(e.tidal ?? '');
    const segs = Array.isArray(e.segments) ? e.segments.slice(0, 60) : [];
    const ok = /^\d{1,15}$/.test(tidal) && segs.length > 0 && segs.every((x, i) => Array.isArray(x) && Number.isFinite(x[0]) && x[0] >= 0
      && (i === 0 || x[0] > segs[i - 1][0]) && (x[1] === null || (Number.isFinite(x[1]) && Math.abs(x[1]) <= 600))
      && Number(x[2]) > 0.9 && Number(x[2]) < 1.1) && segs.some((x) => x[1] !== null);
    if (!ok) return null;
    const segments = segs.map((x) => [Number(x[0]), x[1] === null ? null : Number(x[1]), Number(x[2])]);
    let h = 5381;
    for (const ch of JSON.stringify(segments)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return { status: 'ok', tidal, offset: 0, scale: 1, segments, stamp: `${tidal}:seg:${h.toString(36)}` };
  }
  if (e.status !== 'ok') return null;
  const tidal = String(e.tidal ?? '');
  const offset = Number(e.offset);
  const scale = e.scale == null ? 1 : Number(e.scale);
  if (!/^\d{1,15}$/.test(tidal) || typeof e.offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > 600
      || !(scale > 0.9 && scale < 1.1)) return null;
  return { status: 'ok', tidal, offset, scale, stamp: `${tidal}:${offset}:${scale}` };
}

// ---------------------------------------------------------------- sign-in helpers (PKCE)

function yhdxBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function yhdxPkce(cryptoApi = globalThis.crypto) {
  const verifier = yhdxBase64Url(cryptoApi.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: yhdxBase64Url(digest), state: yhdxBase64Url(cryptoApi.getRandomValues(new Uint8Array(16))) };
}

function yhdxTidalAuthorizeUrl(clientId, redirectUri, pkce, scopes = 'search.read playback user.read') {
  return 'https://login.tidal.com/authorize?response_type=code' +
    `&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}&code_challenge_method=S256&code_challenge=${pkce.challenge}&state=${pkce.state}`;
}
