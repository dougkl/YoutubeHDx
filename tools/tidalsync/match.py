# Python port of YoutubeHDx extension-player/tidal.js "same song" rules (yhdxSongParse / yhdxTidalSameSong / pick).
import re, unicodedata
MARKERS = re.compile(r"\b(live|acoustic|unplugged|remix|rmx|mix|cover|demo|extended|long|edit|instrumental|karaoke|version|stereo|mono|concert|session|tour|totp|top of the pops|reprise|medley|mashup|parody|tribute|orchestral|symphonic|a ?cappella|rehearsal|bootleg|dub|reggae|slowed|sped up|nightcore|pt|part|cut|short|radio)\b")
PLAIN = re.compile(r"\b(official|video|music video|official video|hd|original) version\b")
NOISE = re.compile(r"\b(official|officiel|video|videoclip|clip|music|audio|hd|hq|uhd|4k|8k|1080p|720p|480p|remastered|remaster|original|widescreen|lyrics?|mv|promo|film|vod|full|high quality)\b")
SMALL = {'at','the','of','in','from','a','an','and','on','for','with','to','by','s'}
def fold(s):
    s = re.sub(r"[’‘`´']", "'", str(s or "")).replace("&", " and ").replace("+", " and ")
    s = unicodedata.normalize("NFD", s); s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower()
def norm(p):
    t = fold(p)
    t = re.sub(r"\s*\b(feat\.?|ft\.?|featuring)\s.*$", "", t)
    t = re.sub(r"[(\[{][^)\]}]*[)\]}]", " ", t)
    t = re.sub(r"\b(19|20)\d{2}\b", " ", t)
    t = MARKERS.sub(" ", NOISE.sub(" ", PLAIN.sub(" ", t)))
    t = re.sub(r"[^\w]+|_", " ", t.replace("'", "")).strip()
    return t[4:] if t.startswith("the ") else t
def clean_channel(a):
    a = str(a or "").strip()
    if re.search(r"\s*-\s*Topic$", a, re.I): return re.sub(r"\s*-\s*Topic$", "", a, flags=re.I).strip()
    if a.endswith("VEVO"): a = re.sub(r"([a-z])([A-Z])", r"\1 \2", a[:-4])
    return a.strip()
def parse(title, hint=""):
    raw = str(title or "").strip(); low = fold(raw)
    kind = "lyrics" if re.search(r"\blyrics?\b", low) else "audio" if re.search(r"\b(official )?audio\b|\bvisuali[sz]er\b", low) else "video"
    mk = {}
    for m in MARKERS.finditer(PLAIN.sub(" ", low)):
        w = m.group(0).replace(" ", ""); mk[w] = mk.get(w, 0) + 1
    parts = re.split(r"\s+[-–—~]\s*|\s*[-–—~]\s+|\s*~\s*|\s{3,}", raw)
    if len(parts) >= 2 and norm(parts[0]) and norm(" - ".join(parts[1:])):
        art, tr = norm(parts[0]), norm(" - ".join(parts[1:]))
    elif raw.count("-") == 1 and raw.index("-") > 0 and " " in raw[:raw.index("-")].strip() and norm(raw[raw.index("-")+1:]):
        art, tr = norm(raw[:raw.index("-")]), norm(raw[raw.index("-")+1:])
    else:
        art, tr = (norm(clean_channel(hint)) if hint else ""), norm(raw)
    return {"artist": art, "track": tr, "kind": kind, "markers": mk, "raw": raw}
def sim(a, b):
    if a == b: return 1
    prev = list(range(len(b)+1))
    for i in range(1, len(a)+1):
        cur = [i]
        for j in range(1, len(b)+1): cur.append(min(cur[j-1]+1, prev[j]+1, prev[j-1]+(a[i-1] != b[j-1])))
        prev = cur
    return 1 - prev[len(b)] / max(len(a), len(b))
def details(s):
    t = fold(s["raw"]).replace("'", "")
    t = re.sub(r"\b(feat\.?|ft\.?|featuring|with)\s[^()\[\]{}\-–—]*", " ", t)
    t = MARKERS.sub(" ", NOISE.sub(" ", PLAIN.sub(" ", re.sub(r"\b(19|20)\d{2}\b", " ", t))))
    w = {x for x in re.split(r"[^\w]+|_", t) if x}
    for x in f"{s['artist']} {s['track']}".split(): w.discard(x); w.discard(x+"s")
    return {x for x in w if not (x in SMALL or len(x) == 1 or (x.isdigit() and len(x) <= 2))}
def same_markers(a, b): return a["markers"] == b["markers"]
def same_rec(a, b):
    if not (a["track"] and b["track"] and a["artist"] and b["artist"]) or not same_markers(a, b): return False
    if not ((a["artist"] == b["artist"] and a["track"] == b["track"]) or (a["artist"] == b["track"] and a["track"] == b["artist"])): return False
    if a["markers"]:
        da, db = details(a), details(b)
        if (not da) != (not db): return False
        if da and db and not (da & db) and sim(" ".join(da), " ".join(db)) < 0.8: return False
    return True
CUT_M = {"radio","edit","cut","short","version"}; CUT_D = {"single","video","album"}
def only_cut(s): return bool(s["markers"]) and all(m in CUT_M for m in s["markers"]) and all(w in CUT_D for w in details(s))
def uncut(s): return {**s, "markers": {}}
def tidal_same_song(video, artists, title, version):
    names = list(dict.fromkeys(artists + ([" & ".join(artists), ", ".join(artists)] if len(artists) > 1 else [])))
    full = f"{title} ({version})" if version else title
    for a in names:
        t = {**parse(f"{a} - {full}"), "kind": video["kind"]}
        if same_rec(video, t): return True
        if not video["markers"] and only_cut(t) and same_rec(video, uncut(t)): return True
        if not t["markers"] and only_cut(video) and same_rec(uncut(video), t): return True
    return False
