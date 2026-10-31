YoutubeHDx install pack
=======================

Two parts, one per PC. Each installs for the Windows user who runs it; no admin needed
(Windows may ask permission once while winget installs .NET or Chrome).


DOWNLOAD SERVER  ->  Downloader\Install-Downloader.cmd
----------------------------------------------------
Double-click it. It:
  - installs yt-dlp, ffmpeg, Deno, the .NET 8 Desktop Runtime and Chrome (skips what's already there)
  - installs the YoutubeHDx app to %LocalAppData%\Programs\YoutubeHDx, starts it at logon,
    and restarts it within 15 minutes if it ever stops
  - creates settings from Downloader\downloader-config.json (your NAS folder + watched playlists)
  - adds a daily task that keeps yt-dlp up to date
  - opens Chrome's extensions page

Then, in Chrome on the server (one time):
  1. Sign in to YouTube with your Premium account.
  2. Developer mode ON -> Load unpacked -> %LocalAppData%\Programs\YoutubeHDx\extension
     (the path is on your clipboard)
  3. Click the extension icon: green "Signed in" = downloads use your account.

The server must stay logged in to Windows (the app lives in the tray).
Settings: tray icon -> Edit settings...   Log: tray icon -> Open log.


PLAYBACK PC  ->  Player\Install-Player.cmd
------------------------------------------
Double-click it, then in Chrome: Developer mode ON -> Load unpacked ->
%LocalAppData%\Programs\YoutubeHDx-Player\extension
Click the YoutubeHDx Player icon to set quality, caption language and caption style.
Nothing else is installed on the playback PC, and it never holds your YouTube login.


UPDATING
--------
Run the same Install-*.cmd from a newer pack. Settings, login and download history are kept.
Then click the reload icon on the extension card in chrome://extensions.


ONLY ONE DOWNLOADER
-------------------
Run the downloader on one PC only. If it was installed on another PC before, run
Downloader\Uninstall-Downloader.cmd there. The download history lives on the NAS
(.youtubehdx-archive.txt), so the server skips everything already downloaded.
