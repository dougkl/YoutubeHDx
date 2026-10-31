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

Run the downloader on one PC only. The download history (`.youtubehdx-archive.txt`) lives on the NAS, so a new server skips what's already downloaded.

## Using it

- **Downloader popup** (server): *Download this video in 4K*, *Download whole playlist*, or *Auto-sync this playlist*. Shows sign-in state and live progress.
- **Right-click** any YouTube link or video page → *Download in 4K to NAS*.
- **Tray app**: paste URLs, cancel jobs, sync watched playlists now, open the NAS folder or the log.
- **Pause**: tray icon → *Pause downloads* (15 min, 1 h, 3 h, 8 h, or until you resume), or the pause buttons in the Downloader popup. The running download stops at once so your bandwidth is free; *Resume downloads* (or the end of the pause time) continues it from its partial file. A pause survives app restarts.
- **Crash-safe**: unfinished jobs are saved to `queue.json` and come back when the app restarts (after a crash, sign-out or reboot). Finished videos are recorded in `.youtubehdx-archive.txt` on the NAS and never downloaded twice; half-done videos continue from their `.part` file in the temp folder.
- **Auto-sync**: watched playlists are checked every `watchIntervalMinutes`. Already-downloaded videos are skipped via `.youtubehdx-archive.txt` on the NAS.
- **Stuck captions fixed automatically**: YouTube sometimes answers the caption request with no data (its anti-bot token wasn't ready, e.g. during an ad), leaving CC "on" with nothing shown. The Player watches those replies (read-only) and, like toggling CC off/on, requests them again: up to two re-requests, then one reload of the video at the same second.
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
| `outputTemplate` | see above | yt-dlp output template, relative to `nasPath` |
| `extraArgs` | `""` | Raw yt-dlp args, e.g. PO token provider `--extractor-args` |
| `maxConcurrentDownloads` | `1` | 1–4; read at app start |
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
