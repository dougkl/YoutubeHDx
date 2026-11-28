"""Run: python -m unittest tools/tidalsync/test_align.py"""
import sys, pathlib, unittest
import numpy as np
from scipy.signal import resample
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from align import align, SR


def song(seconds, seed=1):
    """A drum-like track: random clicks and tones, so onsets are distinct everywhere."""
    rng = np.random.default_rng(seed)
    x = np.zeros(int(seconds * SR), np.float32)
    t = 0.0
    while t < seconds - 1:
        n = int(t * SR); L = int(0.12 * SR)
        f = rng.uniform(150, 2500)
        x[n:n + L] += (np.sin(2 * np.pi * f * np.arange(L) / SR) * np.exp(-np.arange(L) / (0.03 * SR))).astype(np.float32)
        t += rng.uniform(0.15, 0.6)
    return x + rng.normal(0, 0.01, len(x)).astype(np.float32)


class AlignTest(unittest.TestCase):
    def test_intro_shift(self):
        tidal = song(200)
        video = np.concatenate([np.zeros(int(8 * SR), np.float32), tidal])   # video has an 8 s intro
        r = align(video, tidal)
        self.assertEqual(r["status"], "ok")
        self.assertAlmostEqual(r["offset"], -8.0, delta=0.02)
        self.assertEqual(r["scale"], 1.0)

    def test_ntsc_speed(self):
        tidal = song(240, seed=2)
        video = resample(tidal, int(len(tidal) * 1001 / 1000)).astype(np.float32)  # video 0.1 % slower
        r = align(video, tidal)
        self.assertEqual(r["status"], "ok")
        self.assertAlmostEqual(r["scale"], 1000 / 1001, delta=1e-4)
        self.assertAlmostEqual(r["offset"], 0.0, delta=0.03)

    def test_cut_in_the_middle_is_not_ok(self):
        tidal = song(240, seed=3)
        video = np.concatenate([tidal[:int(100 * SR)], tidal[int(120 * SR):]])  # 20 s cut out of the video
        self.assertNotEqual(align(video, tidal)["status"], "ok")

    def test_another_song_is_not_ok(self):
        self.assertNotEqual(align(song(200, seed=4), song(200, seed=5))["status"], "ok")


if __name__ == "__main__":
    unittest.main()
