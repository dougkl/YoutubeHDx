# YoutubeHDx

4K YouTube archiving to your NAS using your YouTube Premium account, plus a player extension that keeps playback at 4K with clean English captions.

Two machines, two extensions:

| PC | Installs | Does |
|---|---|---|
| **Download server** | YoutubeHDx app (tray) + **YoutubeHDx Downloader** extension | Auto-syncs watched playlists, one-click downloads, sends your login to the app |
| **Playback PC** | **YoutubeHDx Player** extension only | Always 4K, human-made English captions only, your caption style. No login, no downloads |

```
Downloader extension ──native messaging──► NativeHost.exe ──named pipe──► YoutubeHDx.App (tray)
 (buttons + login cookies)                   (saves cookies,               (queue → yt-dlp + ffmpeg
                                              forwards request)              → temp → NAS)
```

The extensions never download anything themselves; the C# app does the work.

## Projects

| Project | What it does |
|---|---|
| `src/YoutubeHDx.Core` | yt-dlp wrapper, download queue, playlist watcher, settings, cookie export, pipe protocol |
| `src/YoutubeHDx.App` | Tray app (WinForms): runs the queue, shows progress, notifies when files land on the NAS |
| `src/YoutubeHDx.NativeHost` | Chrome native messaging host; started by Chrome per message, forwards to the app |
| `extension-downloader/` | MV3: download buttons, right-click menu, login sync. Fixed key so its ID is always `jankpmgafaifknohonbbhcdhgkpdocfa` |
| `extension-player/` | MV3: always-4K playback, English captions (human-made only), caption styling. Only the `storage` permission |
| `install/pack/` | Installers that go into the pack |

## Install (pack)

On your dev PC, build the pack. It takes the NAS folder and watched playlists from this PC's settings:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\build-pack.ps1
```

This creates `dist\YoutubeHDx-Pack-<version>.zip`. Add `-PublishTo '\\nas\media\Software\YoutubeHDx'` to also copy it to the NAS. Each version goes in its own folder, and a `.plexignore` keeps Plex from scanning it (plus `.ignore` for Jellyfin). Bump `version` in both `extension-*\manifest.json` before publishing a new build. Copy it to each PC, unzip, and double-click:

- **Download server:** `Downloader\Install-Downloader.cmd`. Installs yt-dlp, ffmpeg, Deno, .NET 8 Desktop Runtime and Chrome via winget, installs the app for the current user, registers it with Chrome/Edge, keeps it running (starts at logon and restarts within 15 minutes if it ever stops), and adds a daily yt-dlp update task. Then in Chrome: sign in to YouTube (Premium) and load `%LocalAppData%\Programs\YoutubeHDx\extension` unpacked.
- **Playback PC:** `Player\Install-Player.cmd`. Then load `%LocalAppData%\Programs\YoutubeHDx-Player\extension` unpacked.

The `.cmd` launchers work even when PowerShell scripts are restricted (e.g. `AllSigned`). Re-running an installer from a newer pack updates in place and keeps settings, login and history. `Uninstall-*.cmd` removes everything except the downloaded videos (and, unless `-RemoveData`, your settings).

When published with `-PublishTo`, the NAS folder also gets `Install-Latest-Player.cmd` and `Install-Latest-Downloader.cmd`: double-click on a PC to install or update from the newest pack there.

Run the downloader on one PC only. The download history (`.youtubehdx-archive.txt`) lives on the NAS, so a new server skips what's already downloaded.

## Using it

- **Downloader popup** (server): *Download this video in 4K*, *Download whole playlist*, or *Auto-sync this playlist*. Shows sign-in state and live progress.
- **Right-click** any YouTube link or video page → *Download in 4K to NAS*.
- **Tray app**: paste URLs, cancel jobs, sync watched playlists now, open the NAS folder or the log.
- **Pause**: tray icon → *Pause downloads* (15 min, 1 h, 3 h, 8 h, or until you resume), or the pause buttons in the Downloader popup. The running download stops at once so your bandwidth is free; *Resume downloads* (or the end of the pause time) continues it from its partial file. A pause survives app restarts.
- **Subtitle scan**: checks downloaded videos for missing or bad English subtitles (empty, almost empty, running past the end of the video, or covering only its start) and adds a sidecar `Title [id].en.srt` with the song's synced lyrics, from LRCLIB (then OpenSubtitles if `openSubtitlesApiKey` is set), used only when the song's length is within 3 s of the video. Runs after each download, once a day (`subtitleScanIntervalHours`), and from tray → *Subtitles → Scan subtitles now*. Never edits or deletes files: if a sidecar name is taken, it uses `.en.lyrics.srt`, `.en.lyrics2.srt`, ... Results are remembered, so unchanged files are skipped; no lyrics found is retried after 7 days (1 hour if the site was down). Stops while downloads are paused.
- **Bad subtitles list**: tray → *Subtitles → Mark subtitles as bad…* (paste a YouTube link or the file name), or add lines to `.youtubehdx-badsubs.txt` in the download folder. The next scan adds subtitles from another source; listing the same video again means "still wrong, try another".
- **Downloads window**: one line per playlist or video. A new sync of the same playlist replaces its line (while it waits, the line shows what the previous run found). Statuses are in plain words: *Checking for new videos*, *Downloading #12 of 340*, *Up to date*, *Done: 2 new*, *Done: 2 new, some failed*, *Failed*. Videos removed, private or blocked on YouTube are not errors: they are counted ("3 unavailable on YouTube") and listed in `unavailable-videos.csv`. Real errors say what to do (e.g. "YouTube wants you signed in again: … click the YoutubeHDx extension icon"); hover a line for yt-dlp's exact message. The *Subtitles* column shows the result for each saved video (OK / lyrics added / none found). Below the downloads, *Subtitles and Plex files* shows the subtitle check and the .nfo/.jpg pass: which file it is on, how far along, and the result of the last run.
- **Duplicates ("other dirs")**: looks through your music-video folders (`duplicateFolders`, set from the Duplicates tab → *Folders to check…*; subfolders named in `duplicateSkipFolders` are skipped) and, when the same song is saved more than once, keeps the best copy visible in Plex and hides the others with `.plexignore`. Nothing is deleted. Best = highest resolution; at the same resolution the YoutubeHDx copy (it has the proper subtitles, .nfo and picture), then bitrate. Two files are only treated as the same song when artist and song match (ignoring "(Official Video)", "[HD]", "Remastered", years, "ft." guests…, also reversed like "Song - Artist"), neither has a version word the other lacks (*live, acoustic, remix, mix, cover, demo, extended, long, edit, version, stereo, session, part…*: "Let It Be" and "Let It Be (Live)" are different songs) and their lengths agree within 3 s (or 2%). Near misses (lengths 4–25 s apart, one name without the artist, a lyric/audio video, spelling variants) are never hidden automatically: they go to **Check these**, where you answer *Same song* or *Different songs* (remembered). The **Duplicates** tab lists every hidden copy next to the copy that's kept, with quality, length and size: *Un-ignore* shows one again for good, *Ignore again* undoes that, *Move to…* moves several (with their subtitles) to a folder you pick. Our lines in `.plexignore` sit between two marker comments; your own lines are kept. If a file can't be hidden by name without also hiding another file (Plex has no exact-name rule, and brackets in names have to become wildcards), it's marked "Can't hide by name": use *Move to…* for those. Runs at start-up, daily, and from the tab or tray → *Library (Plex) → Find duplicates now*.
- **TIDAL "better audio" playlist**: keeps a playlist *YoutubeHDx – better audio* (Unlisted) in your TIDAL account with every song from your music-video library whose TIDAL track is the same recording at the same length as the video (within 2 s), i.e. the ones whose sound could be replaced by the TIDAL/CD-quality version without any editing. Same "same song" rules as the duplicate check (a live, remix, radio edit, short cut, long version... never counts as the plain song). Every result, including the near misses ("on TIDAL, different length" with the difference in seconds), goes to `better-audio-tidal.csv` next to your downloads. Uses TIDAL's official API: create a free app at developer.tidal.com (redirect URI `http://localhost:51735/tidal-callback`, scopes search.read, playlists.read, playlists.write, user.read), then tray → *Library (Plex) → TIDAL better-audio playlist: update now* asks for the Client ID (never the secret) and opens TIDAL's own sign-in page. If your browser won't open the localhost page TIDAL sends you back to, paste the address it shows into the box the app opens. The sign-in is stored encrypted for your Windows user; it updates daily after that.
- **Plex-friendly names and info files**: files are saved under their YouTube title, e.g. `Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].mkv` (no date in front). Files saved by 1.4.0 and older (`2014-07-18 - …`) are renamed once, together with their `.srt`/`.jpg`, never overwriting anything; every rename is listed in `renamed-files.csv` in the download folder. Next to each video the app also writes `Name [id].nfo` (artist, song, YouTube title, description, link, playlist as a tag, artist as a collection) and `Name [id].jpg` (the YouTube thumbnail, or a frame of the video if YouTube no longer has it). The `.nfo` uses the `<movie>` layout, read by Plex's **Plex NFO Movie** agent (Plex Media Server 1.43.1+, library → Edit → Advanced → Agent), Jellyfin, Emby and Kodi. Only missing files are created. Runs at start-up, daily, after each download, and from tray → *Library (Plex) → Fix file names and add info files now*.
- **Unavailable videos**: videos a sync can't get because they're removed, private, blocked in your country, copyright-blocked, members-only or age-restricted go to `unavailable-videos.csv` in the download folder (date, id, link, title, channel, playlist, reason), each once, so you can look for them elsewhere. Temporary errors aren't listed. Tray → *Open unavailable-videos list*.
- **Crash-safe**: unfinished jobs are saved to `queue.json` and come back when the app restarts (after a crash, sign-out or reboot). Finished videos are recorded in `.youtubehdx-archive.txt` on the NAS and never downloaded twice; half-done videos continue from their `.part` file in the temp folder.
- **Auto-sync**: watched playlists are checked every `watchIntervalMinutes`. Already-downloaded videos are skipped via `.youtubehdx-archive.txt` on the NAS.
- **Stuck captions fixed automatically**: YouTube sometimes answers the caption request with no data (its anti-bot token wasn't ready, e.g. during an ad), leaving CC "on" with nothing shown. The Player watches those replies (read-only) and, like toggling CC off/on, requests them again: up to two re-requests, then one reload of the video at the same second.
- **Lyrics when there are no captions**: on videos with no human-made English captions, the Player shows the song's synced lyrics as captions (in your caption style). Artist and song come from the video title; lyrics come from [LRCLIB](https://lrclib.net) (free, no account) and are used only when the song's length is within 3 s of the video, so the timing lines up. Optional fallback: OpenSubtitles, with your API key entered in the Player settings (stored on that PC only). Results are cached (found: 30 days, not found: 7 days, site down: retry after 1 hour). Only the video title and length are sent.
- **Subtitles out of sync?** A ⇄ button next to CC in the player's control bar (also in fullscreen). For YouTube's captions: *try other subtitles* (that track is skipped for this video and lyrics are used instead). For lyrics: *try other lyrics* (the next match within 3 s, then OpenSubtitles), *show 0.5 s earlier / later*. Plus *turn subtitles off for this video* and *reset*. Choices are remembered per video on that PC; Player settings has a button to forget them all.
- **TIDAL audio for music videos (Player)**: when TIDAL has the same recording at the same length as the music video (within 2 s; same "same song" rules as the downloader: a live, remix, mix, edit, cut… never counts as the plain song), a faded *♪ High-quality audio found · TIDAL* sign shows at the bottom left, YouTube's sound is muted and TIDAL's plays instead, through TIDAL's official web player ([`@tidal-music/player`](https://github.com/tidal-music/tidal-sdk-web), Apache-2.0) in an offscreen page of the extension. Nothing is downloaded or recorded. The video stays the clock: its time, play/pause, seeking and speed go to the TIDAL player four times a second, which closes small gaps by playing up to 4% faster or slower and jumps for big ones; ads keep their own sound. The ⇄ button and YouTube's right-click menu (*YoutubeHDx: subtitles and audio…*, *use YouTube's / TIDAL's sound*) can switch back for a video, move TIDAL's sound 0.1 s earlier/later, or reject the TIDAL track ("not the same recording") so another one is tried — all remembered per video. Setup: in your developer.tidal.com app add the redirect URI shown in the Player settings (`https://<extension id>.chromiumapp.org/tidal`), then *Sign in to TIDAL* there (the install pack fills in the Client ID from the downloader's settings). TIDAL plays on one device per account at a time. **Current limit (Nov 2026):** TIDAL gives apps registered on developer.tidal.com 30-second previews only (`FULL_REQUIRES_HIGHER_ACCESS_TIER`, even with a paid subscription); full tracks need a higher access tier that TIDAL grants. Until then the Player says so once, keeps YouTube's sound, shows it in its settings, and checks again once a day, so it starts working by itself if TIDAL raises the app's access. The offscreen player is built by `tools/build-tidal-player.sh` (Node + esbuild) and committed, so installing needs nothing extra.
- **No end cards or comments**: the Player hides YouTube's comments, its end cards (the video/channel/playlist boxes over the last seconds and the "i" info-card teasers) and the suggestions wall when a video ends. The autoplay countdown stays, so autoplay can still be canceled. Both are switches in the Player settings.
- **Player** (playback PC): defaults to the highest resolution, human-made English captions only, and 14px yellow outlined captions with no background box. Click the YoutubeHDx Player icon to change quality, caption behaviour, caption language order, and font/size/colours (live preview).

## Output

```
\\nas\media\YouTube\<playlist title or "Singles">\2026-10-27 - Title [videoId].mkv
                                                   2026-10-27 - Title [videoId].en.srt
```

- Video: best stream up to 2160p (VP9/AV1) + best audio, remuxed losslessly into MKV (no re-encoding).
- Subtitles: human-made English only (`--no-write-auto-subs`), embedded in the MKV and kept as a sidecar `.srt`.
- Metadata, chapters and thumbnail are embedded.
- Downloads and merging happen in `tempPath`; yt-dlp moves the finished file to the NAS, so no partial files appear there.

## Settings (`%LocalAppData%\YoutubeHDx\settings.json`)

| Key | Default | Notes |
|---|---|---|
| `nasPath` | `\\nas\media\YouTube` | Must exist and be writable by your Windows user |
| `tempPath` | `%TEMP%\YoutubeHDx` | Local scratch space; needs room for the largest video |
| `ytDlpPath` | `yt-dlp.exe` | Bare name = PATH |
| `ffmpegLocation` | `""` | Folder or exe; empty = PATH |
| `maxHeight` | `2160` | |
| `subtitleLanguages` | `en.*,-live_chat` | yt-dlp `--sub-langs` syntax |
| `embedSubtitles` / `keepSubtitleFiles` | `true` / `true` | |
| `outputTemplate` | `%(playlist_title\|Singles)s/%(title)s [%(id)s].%(ext)s` | yt-dlp output template, relative to `nasPath`. No date in front: Plex read it as part of the artist/title. The `[id]` stays (the subtitle scan uses it) |
| `writeInfoFiles` | `true` | Write `Name [id].nfo` and `Name [id].jpg` next to each video |
| `duplicateCheck` / `duplicateFolders` / `duplicateSkipFolders` | `true` / `[]` (= nasPath) / `needremix, Software, Temp` | Duplicate check on/off, folders to look through (relative to nasPath allowed, e.g. `../..`), subfolder names to skip |
| `tidalClientId` / `tidalCountry` / `tidalPlaylist` | `""` / `US` / `true` | Client ID of your developer.tidal.com app (not secret), search country, daily playlist update |
| `fixDatedFileNames` | `true` | Rename files from versions ≤ 1.4.0 (`2014-07-18 - Name [id].mkv`) to drop the date |
| `extraArgs` | `""` | Raw yt-dlp args, e.g. PO token provider `--extractor-args` |
| `maxConcurrentDownloads` | `1` | 1–4; read at app start |
| `subtitleScan` / `subtitleScanIntervalHours` | `true` / `24` | Subtitle scan on/off and how often the full scan runs |
| `openSubtitlesApiKey` | `""` | Optional fallback source for the subtitle scan |
| `reportUnavailable` | `true` | Write `unavailable-videos.csv` |
| `requireLogin` | `true` | Refuse to download without your YouTube login, so nothing runs anonymously |
| `watchedPlaylists` | `[]` | `{ "url": "...", "name": "...", "enabled": true }` |
| `watchIntervalMinutes` | `360` | Minimum 15 |

## How login works

No password is stored. The extension reads your youtube.com cookies (`chrome.cookies`) and the host writes them to `%LocalAppData%\YoutubeHDx\youtube-cookies.txt`, which yt-dlp uses for every download. That's how your YouTube Premium account is used: yt-dlp detects the subscription from the login and can pick Premium-only formats (such as the higher-bitrate 1080p).

The login is sent when the extension is installed, every time Chrome starts, whenever you open the popup, and every 6 hours. If you're signed out, the saved login is left alone rather than overwritten. The popup shows a green "Signed in" line when it's working.

With `requireLogin` on (the default), the app refuses to download until a signed-in login has been received, so scheduled syncs never fall back to anonymous downloads.

Treat that file like a password: anyone with it can act as your YouTube account.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Downloader popup says the app is not installed | Run `Install-Downloader.cmd` again; check the extension ID is `jankpmgafaifknohonbbhcdhgkpdocfa` |
| Only 360p/720p formats | `yt-dlp -U`. If it persists, install a PO token provider plugin and put its args in `extraArgs` |
| "Sign in to confirm you're not a bot" | Open YouTube in Chrome (signed in) and click download again to refresh cookies |
| "NAS folder is not reachable" | Open the UNC path in Explorer as the same user; save credentials if prompted |
| Captions not switching | The video may only have auto-generated English captions; those are skipped by design |
| Anything else | Tray → *Open log* (`%LocalAppData%\YoutubeHDx\youtubehdx.log`) |

## Tests

```powershell
.\install\run-tests.ps1
```

- `tests/YoutubeHDx.Tests` (C#, no NuGet packages): cookie export, yt-dlp arguments, settings, the real queue and runner against a fake yt-dlp script (success, partial playlist, failures, cancel), the named pipe, and the native host's Chrome framing as a real process. Uses a throwaway data folder, never your real settings.
- `tests/extension` (Node built-in test runner): runs the real scripts of both extensions against a fake YouTube player and a stubbed `chrome` API, covering quality selection, human-made-only captions, ads, SPA navigation, caption CSS, URL parsing, and host messaging.
- Not covered: the WinForms tray UI, and real YouTube/yt-dlp behaviour.

## Notes

- The player tweaks use YouTube's internal player methods (`setPlaybackQualityRange`, captions `getOption`/`setOption`). They're unofficial and may need adjusting when YouTube updates its player.
- Downloading from YouTube is against its Terms of Service. This is meant for personal archiving.

## License

MIT, see [LICENSE](LICENSE).
