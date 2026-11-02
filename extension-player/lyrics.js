// Lyrics for videos without human-made captions: find synced lyrics and turn them into timed cues.
// Pure functions (no chrome.* here) so they can be tested; background.js does caching and messaging.
// Sources: LRCLIB (free, no account; synced song lyrics) first, then OpenSubtitles if an API key is set.

const YHDX_LYRICS_TOLERANCE_S = 3;   // lyrics' song length must be within this many seconds of the video
const YHDX_LRCLIB = 'https://lrclib.net/api';
const YHDX_OPENSUBS = 'https://api.opensubtitles.com/api/v1';

// ---------------------------------------------------------------- video title -> artist / track

const YHDX_TITLE_NOISE =
  /\s*[([{][^)\]}]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k|remaster(ed)?|mv|clip|explicit|stereo|mono|music)\b[^)\]}]*[)\]}]/gi;

function yhdxCleanPart(s) {
  return String(s || '')
    .replace(/[’‘´]/g, "'")                                         // "Don’t" -> "Don't" (LRCLIB uses straight quotes)
    .replace(YHDX_TITLE_NOISE, '')
    .replace(/\s+[-–—]\s+[^-–—]*\b(video|remaster(ed)?|version|official)\b[^-–—]*$/i, '') // "... - Original Video 1985"
    .replace(/\s+[|/]\s+.*$/, '')                                   // "Song | Some Channel"
    .replace(/\s+(official\s+(music\s+)?video|official\s+audio|music\s+video|lyric\s+video)\s*$/i, '')
    .replace(/["“”]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function yhdxCleanAuthor(author) {
  let a = String(author || '').trim();
  if (/\s*-\s*Topic$/i.test(a)) return a.replace(/\s*-\s*Topic$/i, '').trim();
  if (/VEVO$/.test(a)) a = a.replace(/VEVO$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'); // "SimpleMindsVEVO" -> "Simple Minds"
  return a.trim();
}

function yhdxWithoutFeat(track) {
  return track.replace(/\s*[([]?\s*\b(feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?\s*$/i, '').trim();
}

/** Possible (artist, track) pairs to search for, best guess first (at most 3). */
function yhdxParseVideoTitle(title, author) {
  const t = String(title || '').trim();
  const cleanAuthor = yhdxCleanAuthor(author);
  const out = [];
  const add = (artist, track) => {
    artist = yhdxCleanPart(artist);
    track = yhdxCleanPart(track);
    if (!artist || !track) return;
    if (!out.some((c) => c.artist.toLowerCase() === artist.toLowerCase() && c.track.toLowerCase() === track.toLowerCase())) {
      out.push({ artist, track });
    }
  };

  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t);
  if (m) {
    add(m[1], m[2]);
    add(m[1], yhdxWithoutFeat(yhdxCleanPart(m[2])));
    if (cleanAuthor) add(cleanAuthor, m[2]);
  } else if (cleanAuthor) {
    add(cleanAuthor, t);
    add(cleanAuthor, yhdxWithoutFeat(yhdxCleanPart(t)));
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- parsing

/** LRC ("[01:23.45] line") -> cues [{start, end, text}] in seconds. Empty lines end the previous cue. */
function yhdxParseLrc(lrc, duration) {
  const stamps = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const text = raw.slice(tags[tags.length - 1].index + tags[tags.length - 1][0].length).trim();
    for (const tag of tags) {
      const frac = tag[3] ? Number(`0.${tag[3]}`) : 0;
      stamps.push({ start: Number(tag[1]) * 60 + Number(tag[2]) + frac, text });
    }
  }
  stamps.sort((a, b) => a.start - b.start);
  const cues = [];
  for (let i = 0; i < stamps.length; i++) {
    if (!stamps[i].text) continue; // gap marker
    const next = stamps[i + 1]?.start;
    let end = next ?? stamps[i].start + 6;
    end = Math.min(end, stamps[i].start + 8);                      // don't hold a line through a long solo
    if (duration > 0) end = Math.min(end, duration);
    if (end > stamps[i].start) cues.push({ start: stamps[i].start, end, text: stamps[i].text });
  }
  return cues;
}

/** SRT -> cues. Tags like <i> are stripped. */
function yhdxParseSrt(srt) {
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const cues = [];
  for (const block of String(srt || '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const tm = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(block);
    if (!tm) continue;
    const text = block.slice(tm.index + tm[0].length).replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (text) cues.push({ start: toSec(tm[1], tm[2], tm[3], tm[4]), end: toSec(tm[5], tm[6], tm[7], tm[8]), text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- matching

/** Best LRCLIB result with synced lyrics whose length matches the video (skipping ones the user rejected). */
function yhdxPickLrclib(results, duration, tolerance = YHDX_LYRICS_TOLERANCE_S, exclude = []) {
  let best = null;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || r.instrumental || !r.syncedLyrics || typeof r.duration !== 'number') continue;
    if (r.id != null && exclude.includes(`lrclib:${r.id}`)) continue;
    const diff = Math.abs(r.duration - duration);
    if (diff <= tolerance && (!best || diff < best.diff)) best = { r, diff };
  }
  return best?.r ?? null;
}

const yhdxNorm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** OpenSubtitles has no song length to compare, so: the title must match and the lines must fit the video. */
function yhdxSubsFitVideo(cues, duration, tolerance = YHDX_LYRICS_TOLERANCE_S) {
  if (!cues.length || !(duration > 0)) return false;
  const lastEnd = cues[cues.length - 1].end;
  return cues[0].start >= 0 && lastEnd <= duration + tolerance && lastEnd >= duration * 0.4;
}

// ---------------------------------------------------------------- sources

class YhdxSourceError extends Error {} // temporary failure (site down, rate limit): try again later

async function yhdxGetJson(fetchFn, url, init) {
  let res;
  try { res = await fetchFn(url, init); } catch (e) { throw new YhdxSourceError(`network: ${e.message}`); }
  if (res.status === 404) return null;
  if (res.status === 429 || res.status >= 500) throw new YhdxSourceError(`HTTP ${res.status}`);
  if (!res.ok) return null;
  try { return await res.json(); } catch { throw new YhdxSourceError('bad JSON'); }
}

async function yhdxFromLrclib(candidates, duration, fetchFn, exclude = []) {
  for (const c of candidates) {
    const url = `${YHDX_LRCLIB}/search?artist_name=${encodeURIComponent(c.artist)}&track_name=${encodeURIComponent(c.track)}`;
    const results = await yhdxGetJson(fetchFn, url, { headers: { Accept: 'application/json' } });
    const hit = yhdxPickLrclib(results, duration, YHDX_LYRICS_TOLERANCE_S, exclude);
    if (hit) {
      const cues = yhdxParseLrc(hit.syncedLyrics, duration);
      if (cues.length) {
        return {
          source: 'LRCLIB', cues, id: hit.id != null ? `lrclib:${hit.id}` : null,
          matched: `${hit.artistName} - ${hit.trackName} (${Math.round(hit.duration)} s)`,
        };
      }
    }
  }
  return null;
}

async function yhdxFromOpenSubtitles(candidates, duration, apiKey, fetchFn, exclude = []) {
  const headers = { 'Api-Key': apiKey, Accept: 'application/json', 'X-User-Agent': 'YoutubeHDx v1' };
  for (const c of candidates) {
    const q = `${YHDX_OPENSUBS}/subtitles?languages=en&query=${encodeURIComponent(`${c.artist} ${c.track}`)}`;
    const found = await yhdxGetJson(fetchFn, q, { headers });
    const items = Array.isArray(found?.data) ? found.data : [];
    const wanted = yhdxNorm(c.track);
    const item = items.find((d) => {
      const a = d?.attributes;
      const title = yhdxNorm(a?.feature_details?.title || a?.feature_details?.movie_name || a?.release);
      const fileId = a?.files?.[0]?.file_id;
      return fileId && !exclude.includes(`os:${fileId}`) && wanted && title.includes(wanted);
    });
    if (!item) continue;

    const dl = await yhdxGetJson(fetchFn, `${YHDX_OPENSUBS}/download`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: item.attributes.files[0].file_id, sub_format: 'srt' }),
    });
    if (!dl?.link) continue;
    let srt;
    try {
      const res = await fetchFn(dl.link);
      if (!res.ok) throw new YhdxSourceError(`download HTTP ${res.status}`);
      srt = await res.text();
    } catch (e) {
      throw e instanceof YhdxSourceError ? e : new YhdxSourceError(`download: ${e.message}`);
    }
    const cues = yhdxParseSrt(srt);
    if (yhdxSubsFitVideo(cues, duration)) {
      return {
        source: 'OpenSubtitles', cues, id: `os:${item.attributes.files[0].file_id}`,
        matched: item.attributes.feature_details?.title || c.track,
      };
    }
  }
  return null;
}

/**
 * Finds lyrics for a video. Returns {cues, source, matched} or {cues: null, reason, retryable}.
 * retryable = a source was unreachable, so "no lyrics" must not be remembered for long.
 */
async function yhdxFindLyrics({ title, author, duration }, { fetchFn, openSubtitlesKey, exclude = [] } = {}) {
  const candidates = yhdxParseVideoTitle(title, author);
  if (!candidates.length) return { cues: null, reason: 'could not tell artist and song from the title', retryable: false };
  if (!(duration > 0)) return { cues: null, reason: 'video length unknown', retryable: true };

  let retryable = false;
  try {
    const hit = await yhdxFromLrclib(candidates, duration, fetchFn, exclude);
    if (hit) return hit;
  } catch (e) {
    if (!(e instanceof YhdxSourceError)) throw e;
    retryable = true;
  }

  if (openSubtitlesKey) {
    try {
      const hit = await yhdxFromOpenSubtitles(candidates, duration, openSubtitlesKey, fetchFn, exclude);
      if (hit) return hit;
    } catch (e) {
      if (!(e instanceof YhdxSourceError)) throw e;
      retryable = true;
    }
  }
  return { cues: null, reason: 'no lyrics with matching timing', retryable };
}
