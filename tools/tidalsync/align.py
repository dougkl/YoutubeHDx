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
