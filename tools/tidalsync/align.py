"""Line up a TIDAL track with a music video's soundtrack.

offset = TIDAL time - video time (the Player's `audioOffset`: TIDAL plays at video time + offset).
"""
import subprocess
import numpy as np
from scipy.signal import correlate, stft

SR = 11025
HOP = 110
FPS = SR / HOP          # 100.227 frames/s exactly (not 100)


def decode(src, seconds=None):
    """Mono float32 at SR from any file or URL ffmpeg can read."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", src]
    if seconds: cmd += ["-t", str(seconds)]
    cmd += ["-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def flux(x):
    """Onset strength at FPS frames/s (log-spectral flux)."""
    _, _, z = stft(x, fs=SR, nperseg=1024, noverlap=1024 - HOP, boundary=None, padded=False)
    m = np.log1p(np.abs(z) * 100)
    f = np.maximum(np.diff(m, axis=1), 0).sum(axis=0)
    return (f - f.mean()) / (f.std() + 1e-9)


def _best_lag(a, b, lo, hi):
    """Lag L (samples) in [lo, hi] maximising sum a[n] * b[n + L]; returns (L, normalised peak)."""
    c = correlate(b, a, mode="full", method="fft")      # index k <-> lag k - (len(a) - 1)
    lags = np.arange(-(len(a) - 1), len(b))
    sel = (lags >= lo) & (lags <= hi)
    if not sel.any(): return None, 0.0
    k = np.argmax(c[sel]); L = int(lags[sel][k])
    seg = b[max(0, L):max(0, L) + len(a)]
    n = min(len(seg), len(a))
    den = np.sqrt((a[:n] ** 2).sum() * (seg[:n] ** 2).sum()) + 1e-9
    return L, float(c[sel][k] / den)


def _interp(c, k):
    """Sub-frame peak position by a parabola through c[k-1..k+1]."""
    if 0 < k < len(c) - 1:
        d = c[k - 1] - 2 * c[k] + c[k + 1]
        if d < 0: return k + 0.5 * (c[k - 1] - c[k + 1]) / d
    return float(k)


def _window_lag(fa, fb, centre, search):
    """Best lag of window fa inside fb around frame `centre` (+-search frames): (lag frames, peak)."""
    b0 = max(0, centre - search)
    b = fb[b0:centre + len(fa) + search]
    if len(b) < len(fa): return None, 0.0
    c = correlate(b, fa, mode="valid", method="fft")
    norms = np.sqrt(np.convolve(b ** 2, np.ones(len(fa)), mode="valid")) * np.sqrt((fa ** 2).sum()) + 1e-9
    c = c / norms
    k = int(np.argmax(c))
    return b0 + _interp(c, k), float(c[k])


def align(video, tidal, windows=12, win_s=15.0, tol=0.08, floor=0.3):
    """{'offset', 'coarse', 'coarse_peak', 'windows': [(t, offset, peak)], 'good', 'spread', 'status'}"""
    fv, ft = flux(video), flux(tidal)
    Lc, peak = _best_lag(fv, ft, -len(fv), len(ft))
    coarse = Lc / FPS
    start = max(0.0, -coarse) + 3
    end = min(len(fv) / FPS, len(ft) / FPS - coarse) - 3
    out = []
    W = int(win_s * FPS)
    if end - start > win_s:
        for t in np.linspace(start, end - win_s, windows):
            f0 = int(t * FPS); t = f0 / FPS
            fa = fv[f0:f0 + W]
            L, p = _window_lag(fa, ft, int(round((t + coarse) * FPS)), 100)
            if L is None: continue
            out.append((round(float(t), 1), round(L / FPS - t, 3), round(p, 3)))
    good = [w for w in out if w[2] >= floor]
    scale, off, resid = 1.0, coarse, None
    if len(good) >= 3:
        t = np.array([w[0] for w in good]); o = np.array([w[1] for w in good])
        # TIDAL time = scale * video time + off  (o = TIDAL - video = (scale - 1) t + off)
        k, off = np.polyfit(t, o, 1)
        scale = 1.0 + k
        if abs(k) < 2e-4: scale, off = 1.0, float(np.median(o))   # no real speed difference
        resid = float(np.max(np.abs(o - ((scale - 1.0) * t + off))))
    if len(good) >= max(3, int(0.75 * len(out))) and resid is not None and resid <= tol: status = "ok"
    elif len(good) >= 3: status = "cuts"
    else: status = "nomatch"
    return {"offset": round(float(off), 3), "scale": round(float(scale), 6), "coarse": round(coarse, 2),
            "coarse_peak": round(peak, 3), "windows": out, "good": len(good),
            "resid": None if resid is None else round(resid, 3), "status": status}


def _peaks(fa, ft, lo, hi):
    """Normalised correlation of window fa at every TIDAL frame lo..hi: (frames, scores)."""
    lo, hi = max(0, lo), min(len(ft) - len(fa), hi)
    if hi < lo: return np.array([], int), np.array([])
    b = ft[lo:hi + len(fa)]
    c = correlate(b, fa, mode="valid", method="fft")
    norms = np.sqrt(np.convolve(b ** 2, np.ones(len(fa)), mode="valid")) * np.sqrt((fa ** 2).sum()) + 1e-9
    return np.arange(lo, lo + len(c)), c / norms


def segments(video, tidal, step_s=5.0, win_s=10.0, tol=0.08, floor=0.3):
    """For a video edited differently from TIDAL's track: where each part of the video is in TIDAL's song.
    [(from_video_s, offset, scale) ...] in video order; offset None = TIDAL has nothing there (keep the video's own
    sound). Follows the song window by window; only where it stops fitting is the whole song searched (the nearest
    good spot wins, so a repeated chorus elsewhere doesn't). Cut points to ~0.25 s. None if nothing lines up."""
    fv, ft = flux(video), flux(tidal)
    W, S, near = int(win_s * FPS), int(step_s * FPS), int(1.0 * FPS)
    starts = list(range(0, len(fv) - W, S))
    def local(f0, off):                                   # (offset, score) near TIDAL = video + off
        fa = fv[f0:f0 + W]
        if fa.std() < 0.2: return None, 0.0
        c0 = f0 + int(round(off * FPS))
        fr, sc = _peaks(fa, ft, c0 - near, c0 + near)
        if not len(sc): return None, 0.0
        k = int(np.argmax(sc)); return (fr[k] - f0) / FPS, float(sc[k])
    def anywhere(f0, prev):                               # best spots in the whole song, nearest to prev first
        fa = fv[f0:f0 + W]
        if fa.std() < 0.2: return None, 0.0
        fr, sc = _peaks(fa, ft, 0, len(ft))
        if not len(sc) or sc.max() < floor: return None, float(sc.max()) if len(sc) else 0.0
        good = np.where(sc >= sc.max() - 0.05)[0]
        offs = (fr[good] - f0) / FPS
        k = int(np.argmin(np.abs(offs - prev))) if prev is not None else int(np.argmax(sc[good]))
        return float(offs[k]), float(sc[good][k])
    pts, cur, prev = [], None, None                       # pts: (t, offset or None)
    for n, f0 in enumerate(starts):
        o = None
        if cur is not None:
            o, p = local(f0, cur)
            if p < floor: o = None
        if o is None:
            o2, p2 = anywhere(f0, prev)
            # a new place only counts if the next window carries on there too (not a one-off look-alike)
            if o2 is not None and n + 1 < len(starts):
                o3, p3 = local(starts[n + 1], o2)
                if p3 < floor: o2 = None
            o = o2
        pts.append((f0 / FPS, o))
        if o is not None: cur, prev = o, o
    # runs of the same offset (small drift = speed difference) and runs where nothing fits
    runs = []
    for t, o in pts:
        r = runs[-1] if runs else None
        if r and ((o is None) == (r["o"] is None)) and (o is None or abs(o - r["last"]) <= tol + 0.003 * step_s):
            r["pts"].append((t, o)); r["last"] = o if o is not None else r["last"]
        else:
            runs.append({"o": o, "last": o, "pts": [(t, o)]})
    # a lone window that fits nothing, inside a good part, is noise
    runs = [r for r in runs if not (r["o"] is None and len(r["pts"]) < 2 and r is not runs[0] and r is not runs[-1])]
    if not any(r["o"] is not None for r in runs): return None
    out = []
    for r in runs:
        if r["o"] is None: seg = [r["pts"][0][0], None, 1.0]
        else:
            t = np.array([x[0] for x in r["pts"]]); o = np.array([x[1] for x in r["pts"]])
            k, b = np.polyfit(t, o, 1) if len(t) >= 4 else (0.0, float(np.median(o)))
            if abs(k) < 2e-4: k, b = 0.0, float(np.median(o))
            seg = [float(t[0]), float(b), 1.0 + float(k)]
        if out and ((seg[1] is None and out[-1][1] is None) or (seg[1] is not None and out[-1][1] is not None
                    and abs((seg[0] * seg[2] + seg[1]) - (seg[0] * out[-1][2] + out[-1][1])) <= tol)): continue
        out.append(seg)
    def fits(t0, seg):
        if seg[1] is None: return 0.0
        f0 = int(t0 * FPS); fa = fv[f0:f0 + int(3 * FPS)]
        c = int(round((t0 * seg[2] + seg[1]) * FPS))
        if len(fa) < 10 or c < 0 or c + len(fa) > len(ft): return 0.0
        fb = ft[c:c + len(fa)]
        return float((fa * fb).sum() / (np.sqrt((fa ** 2).sum() * (fb ** 2).sum()) + 1e-9))
    for i in range(1, len(out)):
        a, b = out[i - 1], out[i]
        best, score = b[0], -9
        for t0 in np.arange(max(3.0, b[0] - step_s - win_s / 2), b[0] + win_s / 2, 0.25):
            s_ = fits(t0 - 3, a) - fits(t0, a) + fits(t0, b) - fits(t0 - 3, b)
            if s_ > score: best, score = float(t0), s_
        b[0] = best
    out[0][0] = 0.0
    return [(round(f, 2), None if o is None else round(o, 3), round(sc, 6)) for f, o, sc in out]
