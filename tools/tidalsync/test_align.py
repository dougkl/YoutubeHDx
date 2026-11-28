"""Run: python -m unittest tools/tidalsync/test_align.py"""
import sys, pathlib, unittest
import numpy as np
from scipy.signal import resample
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from align import align, segments, SR


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


class SegmentsTest(unittest.TestCase):
    def test_cut_out_verse(self):
        tidal = song(240, seed=3)
        video = np.concatenate([tidal[:int(100 * SR)], tidal[int(120 * SR):]])   # 20 s cut out at 100 s
        sg = segments(video, tidal)
        self.assertEqual(len(sg), 2)
        self.assertAlmostEqual(sg[0][1], 0.0, delta=0.03)
        self.assertAlmostEqual(sg[1][1], 20.0, delta=0.03)
        self.assertAlmostEqual(sg[1][0], 100.0, delta=0.6)

    def test_skit_not_in_the_song(self):
        tidal = song(200, seed=6)
        skit = song(30, seed=99)                                                  # 30 s the song doesn't have
        video = np.concatenate([tidal[:int(60 * SR)], skit, tidal[int(60 * SR):]])
        sg = segments(video, tidal)
        self.assertEqual([o is None for _, o, _ in sg], [False, True, False])
        self.assertAlmostEqual(sg[1][0], 60.0, delta=0.6)
        self.assertAlmostEqual(sg[2][0], 90.0, delta=0.6)
        self.assertAlmostEqual(sg[2][1], -30.0, delta=0.03)

    def test_repeated_chorus_does_not_confuse_it(self):
        A, B, C, D = song(40, 11), song(25, 12), song(40, 13), song(40, 14)
        tidal = np.concatenate([A, B, C, B, D])                  # the chorus B twice
        video = np.concatenate([A, C, B, D])                     # the video drops the first chorus
        sg = segments(video, tidal)
        found = [(round(f), round(o)) for f, o, _ in sg if o is not None]
        self.assertEqual(found, [(0, 0), (40, 25)])

    def test_plain_video_is_one_part(self):
        tidal = song(200, seed=7)
        video = np.concatenate([np.zeros(int(5 * SR), np.float32), tidal])
        sg = segments(video, tidal)
        self.assertEqual(len([x for x in sg if x[1] is not None]), 1)
        self.assertAlmostEqual([x for x in sg if x[1] is not None][0][1], -5.0, delta=0.03)


if __name__ == "__main__":
    unittest.main()
