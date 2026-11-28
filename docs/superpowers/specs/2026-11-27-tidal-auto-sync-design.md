# TIDAL auto-sync: offsets worked out ahead of time, published on GitHub

Date: 2026-11-27 · Status: draft for Doug's approval

## Intent

Doug watches his music videos full screen on supermachina with the YoutubeHDx Player swapping YouTube's sound for the
matching TIDAL lossless track. Today the Player starts TIDAL "as found" (offset 0) and, when it's off, Doug has to fix it
himself in the Sync TIDAL window or the right-click nudges. He wants never to sync by hand: Claude works out the timing
for his songs ahead of time, publishes it to the GitHub repo, and the Player just reads it.

The file is public on purpose: anyone using the public Player builds gets the same synced videos ("other people can
sync their songs with your decisions"). Entries are keyed by YouTube video id, so they work for every user who plays
that video.

Success: a library video plays, the Player switches to the right TIDAL recording (lossless when TIDAL has it) already in
sync, with nothing on screen and no clicks.

## Goals

- Exact per-video offset (TIDAL time = video time + offset, the Player's existing `audioOffset` meaning), measured by
  comparing the full TIDAL track with the video's own soundtrack.
- Pin the exact TIDAL track per video, so the Player can't pick a worse copy (Harvest Moon: lossy 305 s copy chosen over
  the lossless 303 s one) or another recording with the same name (Rod Stewart's 2018 RPO remake over the 1991 original).
- Detect videos whose edit differs from the track (cut in the middle, extra scene, different ending) and mark them
  "keep YouTube's sound" instead of letting them drift.
- Runs by itself: a nightly job on hypermachina picks up new downloads and pushes changes.
- The Player works exactly as today for videos not in the file.

## Non-goals

- No piecewise sync (re-seeking TIDAL at each cut) in this version: a video with cuts is "keep YouTube".
- No live listening in the browser (TIDAL web audio may be protected; unreliable).
- No new UI. The Sync window and nudges stay as they are for the rare manual fix.

## Anti-goals (failure even if it "works")

- Switching to TIDAL with the wrong song or a drifting/doubled sound. When unsure, keep YouTube's sound.
- Anything appearing over the video.
- Storing TIDAL audio anywhere (streams are analysed in temp files and deleted at once).

## Approaches considered

| | How | Trade-off |
|---|---|---|
| **A (chosen)** | Full TIDAL track (streamed with Doug's TIDAL login via `tidalapi`) aligned against the full video soundtrack | Exact, sees edits; uses his account to stream each track once |
| B | TIDAL's 30-s preview (official API) aligned against the video | Official-API only, but one check point: edits go unnoticed |
| C | The Player listens to both sounds live in Chrome | Protected audio, CPU, fragile; ruled out |

Doug picked A.

## Design

### 1. The sync job (`tools/tidalsync/`, Python, runs on hypermachina)

Python because `tidalapi` (already installed and signed in on hypermachina) gives full streams; the Player's official
API app only gets previews.

1. **Videos to do**: every file under `W:\Music (videos)` whose name ends in `[<11-char YouTube id>]` (976 of 3,710
   today), plus the videos in Doug's two YouTube playlists (`PLKauv8SCR9wnu9Jr9kcqgKuEPdyHNuuxm`,
   `PLKauv8SCR9wmYlZZRniIo-7QeY4oC5euy`). Files without an id are a later step (find the id by title + exact length).
   Done videos are skipped unless their entry's `algorithm` is older than the job's.
2. **Which TIDAL track**: the Player's own rules (a Python port of `tidal.js`'s parse / same-song checks, kept in step
   by shared test cases) find candidates with the same name and markers within 20 s; **lossless/hi-res first**, then
   closest length. Up to 3 candidates are aligned; the best-aligning lossless one wins.
3. **Alignment**:
   - Decode both to mono 11 025 Hz with ffmpeg (video from the NAS file, or `yt-dlp` audio when not on the NAS; TIDAL
     from the stream URL). Temp files deleted after each video.
   - Coarse: cross-correlate onset/energy envelopes (100 frames/s) by FFT over the whole song -> offset to ±10 ms.
   - Fine: cross-correlate raw audio within ±50 ms of it -> offset to ~1 ms.
   - Check: repeat the fine alignment in ~12 windows of 15 s across the song. All windows within 0.08 s of the global
     offset and correlation above a threshold -> `ok`. Windows agreeing in groups with different offsets -> `cuts`
     (keep YouTube). Low correlation everywhere -> `nomatch` (try the next candidate; if none, keep YouTube).
4. **Output**: write `sync/tidal-sync.json`, commit and push to `main` (Doug's rule: straight to main, no PRs) only when
   it changed. A short `sync/tidal-sync-report.md`: counts, and the videos that need a look.
5. **Schedule**: Windows scheduled task on hypermachina, nightly; can also be run by hand.

### 2. The file (`sync/tidal-sync.json`)

```json
{
  "format": 1, "algorithm": 1, "updated": "2026-11-28T03:12:00Z",
  "videos": {
    "n2MtEsrcTTs": { "status": "ok", "tidal": 49651283, "offset": -1.27, "quality": "LOSSLESS", "confidence": 0.94,
                     "title": "Neil Young - Harvest Moon [Official Music Video]", "tidalTitle": "Neil Young - Harvest Moon" },
    "xxxxxxxxxxx": { "status": "keep-youtube", "reason": "cuts", "title": "..." }
  }
}
```

`status`: `ok` (switch, this track, this offset) or `keep-youtube` (reason `cuts` / `nomatch` / `not-on-tidal`).

### 3. Player changes (`extension-player`)

- `background.js` fetches `https://raw.githubusercontent.com/dougkl/YoutubeHDx/main/sync/tidal-sync.json` (new host
  permission), caches it in `chrome.storage.local`, refreshes at start and every 6 h; keeps the last good copy when
  GitHub can't be reached.
- `tidalMatchInner`: video in the file and `ok` -> that track id and offset (no search, no 10–20 s question);
  `keep-youtube` -> keep YouTube's sound silently. Not in the file -> today's matching.
- Precedence: the file's offset replaces an older saved `audioOffset`; a nudge Doug makes after the entry was applied is
  kept for that video (saved with the file's `updated` stamp, so a newer measurement wins again).
- `tidal.js` pick for videos not in the file: lossless/hi-res first among tracks within 2 s, then closest length (fixes
  the Harvest-Moon-style choice even before the job has run).
- TIDAL log lines: "offset from sync file" / "kept YouTube: sync file says cuts". Ready check: "Sync file: loaded,
  N videos, updated <date>". Version bump.

## Constraints

- Repo `dougkl/YoutubeHDx` is public and the file stays public with titles (Doug's decision), shared with every Player
  user, including the public builds from `build-public.ps1`.
- TIDAL track ids can be unavailable in another country: if the pinned track isn't streamable for a user, the Player
  falls back to today's matching for that video (and still never plays a `keep-youtube` video with TIDAL).
- TIDAL streams through Doug's own subscription, personal use, nothing kept.
- hypermachina needs push rights to the repo (it builds there today).

## Left to the builder

Thresholds (correlation floor, window count) tuned on a labelled sample of ~30 videos, including Harvest Moon and
known-edited videos; the shared test-case file for the JS and Python matching rules; retry and back-off for TIDAL rate
limits; the scheduled task's exact time.
