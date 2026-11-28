"""Measure TIDAL sync for library videos. Usage: python job.py <worker> <workers>  |  python job.py merge
Results per worker: %TEMP%/tidalsync/w<worker>.json (resumable). merge -> sync/tidal-sync.json in the repo."""
import sys, os, re, json, glob, pathlib, datetime, time
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
from align import decode, align
from match import parse, tidal_same_song, clean_channel

ALGORITHM = 2   # 2: exact frame rate (100.227/s), retries when TIDAL says too many requests
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


def candidates(s, tidalapi, title, secs):
    v = parse(title, "")
    if not v["artist"] or not v["track"]: return v, []
    seen = {}
    for q in dict.fromkeys([f"{v['artist']} {v['track']}", f"{v['track']} {v['artist']}"]):
      for t in s.search(q, models=[tidalapi.Track], limit=25)["tracks"]:
        if t.id in seen or abs(t.duration - secs) > 180: continue
        if tidal_same_song(v, [a.name for a in t.artists], t.name, t.version or ""): seen[t.id] = t
    if not seen and v["artist"] and v["track"]:  # "Song - Artist" titles: try the other way round
        r = {**v, "artist": v["track"], "track": v["artist"]}
        for t in s.search(f"{r['artist']} {r['track']}", models=[tidalapi.Track], limit=25)["tracks"]:
            if abs(t.duration - secs) <= 180 and tidal_same_song(r, [a.name for a in t.artists], t.name, t.version or ""): seen[t.id] = t
    return v, sorted(seen.values(), key=lambda t: (-RANK.get(str(t.audio_quality).split(".")[-1], 0), abs(t.duration - secs)))[:3]


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
    v, cands = candidates(s, tidalapi, title, secs)
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


def work(wk, nw):
    import tidalapi
    s = tidalapi.Session(); s.load_session_from_file(SESSION); s.audio_quality = tidalapi.Quality.high_lossless
    f = OUT / f"w{wk}.json"
    done = json.load(open(f, encoding="utf-8")) if f.exists() else {}
    items = sorted(library().items())[wk::nw]
    for i, (vid, (title, path)) in enumerate(items):
        old = done.get(vid)
        if old and (old.get("algorithm", 1) >= ALGORITHM or old.get("reason") == "not-on-tidal"): continue
        try: done[vid] = {**measure(s, tidalapi, vid, title, path), "algorithm": ALGORITHM}
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
    merge() if sys.argv[1] == "merge" else work(int(sys.argv[1]), int(sys.argv[2]))
