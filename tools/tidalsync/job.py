"""Measure TIDAL sync for library videos. Usage: python job.py <worker> <workers>  |  python job.py merge
Results per worker: %TEMP%/tidalsync/w<worker>.json (resumable). merge -> sync/tidal-sync.json in the repo."""
import sys, os, re, json, glob, pathlib, datetime, time
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
from align import decode, align
from match import parse, tidal_same_song, clean_channel, norm, sim

ALGORITHM = 3   # 3: artist/song/album from the .nfo, any same-named TIDAL track (the audio decides); 2: exact frame rate
LIB = r"W:\Music (videos)"
REPO = HERE.parent.parent
OUT = pathlib.Path(os.environ["TEMP"]) / "tidalsync"; OUT.mkdir(exist_ok=True)
SESSION = pathlib.Path(os.environ["LOCALAPPDATA"]) / "LiveQueue" / "tidal_session.json"
ID = re.compile(r"\[([\w-]{11})\]$")
RANK = {"HI_RES_LOSSLESS": 3, "HI_RES": 3, "LOSSLESS": 2, "HIGH": 1, "LOW": 0}


def library():
    """{video id: (title, path)} for every library video file named '... [id].ext'."""
    vids = {}
    for p in glob.glob(os.path.join(LIB, "**", "*.*"), recursive=True):
        if not p.lower().endswith((".mkv", ".mp4", ".webm")) or "needremix" in p.lower(): continue
        stem = os.path.splitext(os.path.basename(p))[0]
        m = ID.search(stem)
        if m: vids.setdefault(m.group(1), (stem[:m.start()].strip(), p))
    return vids


PLAYLISTS = ["PLKauv8SCR9wnu9Jr9kcqgKuEPdyHNuuxm", "PLKauv8SCR9wmYlZZRniIo-7QeY4oC5euy"]  # My MTV (Always updated), My MTV 2


def playlist_order():
    """Video ids of the My MTV playlists, top first (refreshed once a day)."""
    f = OUT / "playlist-order.json"
    if f.exists() and time.time() - f.stat().st_mtime < 86400: return json.load(open(f, encoding="utf-8"))
    import subprocess
    ids = []
    for pl in PLAYLISTS:
        out = subprocess.run(["yt-dlp", "--flat-playlist", "--print", "%(id)s", f"https://www.youtube.com/playlist?list={pl}"],
                             capture_output=True, text=True).stdout.split()
        ids += [i for i in out if i not in ids]
    if ids: json.dump(ids, open(f, "w", encoding="utf-8"))
    return ids or (json.load(open(f, encoding="utf-8")) if f.exists() else [])


SHOWS = re.compile(r"\b(the midnight special|toppop|top of the pops|totp|soul train|american bandstand|beat-club|musikladen)\b", re.I)


def song_info(title, path):
    """{artist, song, album[, either]} for a library video. Label uploads ("Provided to YouTube", with an album in the
    .nfo the downloader wrote): the .nfo's artist, song and album. Otherwise the cleaned-up title, both ways round."""
    nfo = os.path.splitext(path)[0] + ".nfo"
    x = open(nfo, encoding="utf-8", errors="replace").read() if os.path.exists(nfo) else ""
    tag = lambda t: (re.search(f"<{t}>(.*?)</{t}>", x, re.S) or [None, ""])[1].strip()
    if tag("album") and tag("artist") and tag("originaltitle"):
        return {"artist": tag("artist"), "song": tag("originaltitle"), "album": tag("album")}
    t = re.sub(r"[\uff5c|\u29f8/]+|--+|~", " - ", title)   # the video's own title (the .nfo's has the channel in front)
    # descriptions in brackets: (Official Video), [Official Music Video], (HD), [Remastered 2015], (Lyrics)...
    t = re.sub(r"[(\[](?=[^)\]]*\b(official|lyrics?|hd|hq|4k|remaster(ed)?|video|audio|visuali[sz]er|clip|upscaled?)\b)[^)\]]*[)\]]", " ", t, flags=re.I)   # fullwidth bar, slashes, -- and ~ as separators
    t = re.sub(r"\[\[.*?\]\]|#\w+|[^\w\s'&(),.!?\-]", " ", t)                       # hashtags, emoji, brackets' leftovers
    t = SHOWS.sub(" ", t)
    t = re.sub(r"\((official|lyrics?|hd|hq|4k|remaster|video|audio|music video|official music video)[^)]*\)", " ", t, flags=re.I)
    parts = [x.strip(" -") for x in re.split(r"\s+-\s+", t) if x.strip(" -")]
    while len(parts) >= 3 and norm(parts[0]) == norm(parts[1]): parts = parts[1:]   # "The Beatles - The Beatles - Hey Jude"
    if len(parts) >= 2: return {"artist": parts[0], "song": parts[1], "album": "", "either": True}
    return {"artist": clean_channel(tag("artist")), "song": parts[0] if parts else title, "album": ""}


def _same_name(a, b):
    a, b = norm(a), norm(b)
    return bool(a and b) and (a == b or sim(a, b) >= 0.85 or (len(a) > 6 and (a in b or b in a)))


def candidates(s, tidalapi, info, secs):
    """Up to 4 TIDAL tracks by that artist with that song name within 240 s of the video: same album first, then
    lossless / Hi-Res, then closest length. Live, remastered, single versions... all count: the audio decides."""
    pairs = [(info["artist"], info["song"])] + ([(info["song"], info["artist"])] if info.get("either") else [])
    seen = {}
    for artist, song in pairs:
        if not song: continue
        for q in dict.fromkeys([f"{artist} {song}".strip(), song]):
            for t in s.search(q, models=[tidalapi.Track], limit=25)["tracks"]:
                if t.id in seen or abs(t.duration - secs) > 240: continue
                names = " ".join(a.name for a in t.artists)
                if artist and not (_same_name(artist, names) or norm(artist) in norm(names) or norm(t.artist.name) in norm(artist)): continue
                if not _same_name(re.split(r" [(\[]", t.name)[0], re.split(r" [(\[]", song)[0]): continue
                seen[t.id] = t
            time.sleep(1)
    album = norm(info.get("album", ""))
    key = lambda t: (0 if album and norm(t.album.name or "").startswith(album[:20]) else 1,
                     -RANK.get(str(t.audio_quality).split(".")[-1], 0), abs(t.duration - secs))
    return sorted(seen.values(), key=key)[:4]


class Busy(Exception):
    """TIDAL keeps saying 'too many requests': stop, and try this video again on the next run."""


def stream_url(t, tries=3):
    wait = 30
    for _ in range(tries):
        try:
            url = t.get_url(); time.sleep(PACE); return url
        except Exception as e:
            if "TooManyRequests" not in type(e).__name__ and "429" not in str(e): raise
            time.sleep(wait); wait = min(wait * 2, 600)
    raise Busy()


PACE = 10  # seconds between TIDAL streams (TIDAL refuses bursts)


def measure(s, tidalapi, vid, title, path):
    video = decode(path)
    secs = len(video) / 11025
    cands = cached_candidates(s, tidalapi, vid, title, path, secs)
    if not cands: return {"status": "keep-youtube", "reason": "not-on-tidal", "title": title}
    best = None
    for t in cands:
        url = stream_url(t)
        r = align(video, decode(url))
        q = str(t.audio_quality).split(".")[-1]
        entry = {"tidal": t.id, "offset": r["offset"], "scale": r["scale"], "quality": q, "resid": r["resid"],
                 "good": r["good"], "of": len(r["windows"]), "title": title,
                 "tidalTitle": f"{t.artist.name} - {t.name}{' (' + t.version + ')' if t.version else ''}"}
        if r["status"] == "ok": return {"status": "ok", **entry}
        if best is None or (r["status"] == "cuts" and best[0] != "cuts"): best = (r["status"], entry)
    st, e = best if best else ("nomatch", {"title": title})
    return {"status": "keep-youtube", "reason": st, **{k: e[k] for k in ("tidal", "tidalTitle", "title") if k in e}}


def cached_candidates(s, tidalapi, vid, title, path, secs):
    """Candidates from prepare (search only), else searched now."""
    f = OUT / "candidates.json"
    cache = json.load(open(f, encoding="utf-8")) if f.exists() else {}
    if vid in cache and cache[vid].get("algorithm") == ALGORITHM:
        return [s.track(i) for i in cache[vid]["ids"]]
    return candidates(s, tidalapi, song_info(title, path), secs)


def prepare():
    """Search TIDAL for every library video's candidates (no streams needed) and keep them for the measuring runs."""
    import tidalapi, subprocess
    s = tidalapi.Session(); s.load_session_from_file(SESSION)
    f = OUT / "candidates.json"
    cache = json.load(open(f, encoding="utf-8")) if f.exists() else {}
    lib = library(); pos = {v: i for i, v in enumerate(playlist_order())}
    for n, (vid, (title, path)) in enumerate(sorted(lib.items(), key=lambda kv: pos.get(kv[0], 10 ** 6))):
        if cache.get(vid, {}).get("algorithm") == ALGORITHM: continue
        try:
            secs = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                        capture_output=True, text=True).stdout.strip() or 0)
            info = song_info(title, path)
            c = candidates(s, tidalapi, info, secs)
        except Exception as e:
            if any(x in str(e) for x in ("429", "400 Client Error", "TooManyRequests")):
                print("TIDAL busy, stopping", flush=True); break
            print(f"{n+1} {vid} error {str(e)[:80]}", flush=True); continue
        cache[vid] = {"algorithm": ALGORITHM, "ids": [t.id for t in c], "info": info,
                      "found": [f"{t.artist.name} - {t.name}{' (' + t.version + ')' if t.version else ''} [{t.album.name}] {t.duration}s" for t in c]}
        print(f"{n+1}/{len(lib)} {vid} {len(c)} | {info['artist']} - {info['song']}", flush=True)
        json.dump(cache, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=0)


def work(wk, nw):
    import tidalapi
    s = tidalapi.Session(); s.load_session_from_file(SESSION); s.audio_quality = tidalapi.Quality.high_lossless
    f = OUT / f"w{wk}.json"
    done = json.load(open(f, encoding="utf-8")) if f.exists() else {}
    lib = library()
    # Top songs first: the order of your My MTV playlists (top of 'My MTV (Always updated)', then 'My MTV 2'),
    # then any other library videos.
    pos = {v: i for i, v in enumerate(playlist_order())}
    items = sorted(lib.items(), key=lambda kv: (pos.get(kv[0], 10 ** 6), kv[1][0].lower()))[wk::nw]
    for i, (vid, (title, path)) in enumerate(items):
        old = done.get(vid)
        if old and old.get("algorithm", 1) >= ALGORITHM: continue
        try: done[vid] = {**measure(s, tidalapi, vid, title, path), "algorithm": ALGORITHM}
        except Exception as e:
            if not isinstance(e, Busy) and not any(x in str(e) for x in ("429", "400 Client Error", "TooManyRequests")): raise
            print(f"[{wk}] TIDAL is busy ({str(e)[:60]}): stopping here; the next run carries on", flush=True); break
        except Busy:
            print(f"[{wk}] TIDAL is busy: stopping here; the next run carries on", flush=True); break
        except Exception as e:
            print(f"[{wk}] {i+1}/{len(items)} {vid} failed ({str(e)[:80]}), tried again next run: {title}", flush=True)
            if not old: done[vid] = {"status": "error", "error": str(e)[:200], "title": title}
            continue
        print(f"[{wk}] {i+1}/{len(items)} {vid} {done[vid]['status']} {done[vid].get('reason','')} {title}", flush=True)
        json.dump(done, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=0)


def merge():
    allv = {}
    for f in glob.glob(str(OUT / "w*.json")): allv.update(json.load(open(f, encoding="utf-8")))
    # Published: measured syncs, and "keep YouTube" only where a TIDAL track was really measured and didn't fit
    # (not when the search found nothing, or TIDAL couldn't be reached: the Player's own matching stays for those).
    vids = {k: v for k, v in sorted(allv.items())
            if v.get("status") == "ok" or (v.get("status") == "keep-youtube" and "tidal" in v)}
    doc = {"format": 1, "algorithm": ALGORITHM, "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "videos": vids}
    (REPO / "sync").mkdir(exist_ok=True)
    json.dump(doc, open(REPO / "sync" / "tidal-sync.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    from collections import Counter
    c = Counter((v["status"], v.get("reason", "")) for v in allv.values())
    print(json.dumps({f"{a} {b}".strip(): n for (a, b), n in c.items()}, indent=1))


if __name__ == "__main__":
    {"merge": merge, "prepare": prepare}.get(sys.argv[1], lambda: work(int(sys.argv[1]), int(sys.argv[2])))()
