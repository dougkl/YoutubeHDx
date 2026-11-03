using System.Diagnostics;
using YoutubeHDx.Core;
using YoutubeHDx.Core.Library;
using YoutubeHDx.Core.Lyrics;
using YoutubeHDx.Core.Subtitles;
using YoutubeHDx.Core.Tidal;

namespace YoutubeHDx.App;

/// <summary>Tray icon + background services: download queue, pipe server for the extension, playlist watcher.</summary>
internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon _tray;
    private readonly DownloadQueue _queue;
    private readonly IpcServer _ipc;
    private readonly WatchScheduler _watcher;
    private readonly SynchronizationContext _ui;
    private MainForm? _form;
    private ToolStripMenuItem _pauseMenu = null!;
    private ToolStripMenuItem _resumeItem = null!;
    private readonly System.Windows.Forms.Timer _pauseTicker = new() { Interval = 15_000 };
    private readonly SubtitleScanner _scanner;
    private readonly InfoFileWriter _info;
    private readonly ActivityBoard _board = new();
    private readonly DuplicateFinder _duplicates;
    private readonly BetterAudioPlaylist _tidal;
    private readonly CancellationTokenSource _stop = new();
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    public TrayContext()
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

        AppSettings settings;
        try
        {
            settings = SettingsStore.Load();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(ex.Message, "YoutubeHDx", MessageBoxButtons.OK, MessageBoxIcon.Error);
            settings = new AppSettings();
        }

        _queue = new DownloadQueue(FileLog.Write);
        _queue.JobFinished += job => _ui.Post(_ => OnJobFinished(job), null);
        _queue.Reporter = new UnavailableReporter(SettingsStore.Load, null, FileLog.Write);

        // Subtitle scan: new downloads right away, the whole library daily, and on demand from the tray.
        _scanner = new SubtitleScanner(SettingsStore.Load, new FfmpegProbe(SettingsStore.Load),
            s => new LyricsFinder(Http, s.OpenSubtitlesApiKey), () => _queue.PauseState.IsPaused, FileLog.Write);
        _scanner.Board = _board;
        _info = new InfoFileWriter(SettingsStore.Load, new FfmpegProbe(SettingsStore.Load), Http, FileLog.Write) { Board = _board };
        _duplicates = new DuplicateFinder(SettingsStore.Load, new FfmpegProbe(SettingsStore.Load), FileLog.Write) { Board = _board };
        var tidalApi = new TidalApi(Http, async ct =>
            (await TidalAuth.GetValidAsync(Http, SettingsStore.Load().TidalClientId, ct)
             ?? throw new InvalidOperationException("Not signed in to TIDAL (tray → Library → TIDAL better-audio playlist).")).AccessToken,
            settings.TidalCountry);
        _tidal = new BetterAudioPlaylist(SettingsStore.Load, tidalApi, FileLog.Write) { Board = _board };
        _queue.FileSaved += (path, job) => _ = SafeBackground(async () =>
        {
            var s = SettingsStore.Load();
            if (s.WriteInfoFiles) await _info.WriteForAsync(path, _stop.Token);
            if (s.SubtitleScan) job.AddSubtitleOutcome(await _scanner.ScanFileAsync(path, _stop.Token)); // shown on the job's line
        });
        if (settings.SubtitleScan)
            _board.Finish(SubtitleScanner.ActivityKey, SubtitleScanner.ActivityName, "Checks each new download; the full check runs 30 min after start-up, then daily");
        _ = SafeBackground(() => TidyLibraryAsync(announce: false)); // drop old date prefixes, add missing .nfo/.jpg
        _ = DailySubtitleScanAsync();

        _queue.Start(settings.MaxConcurrentDownloads);

        _ipc = new IpcServer(HandleIpc, FileLog.Write);
        _ipc.Start();

        _watcher = new WatchScheduler(_queue, FileLog.Write);
        _watcher.Start();

        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "YoutubeHDx",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _tray.DoubleClick += (_, _) => ShowForm();

        _queue.PauseChanged += state => _ui.Post(_ => OnPauseChanged(state, announce: true), null);
        _pauseTicker.Tick += (_, _) => OnPauseChanged(_queue.PauseState, announce: false); // also ends timed pauses
        _pauseTicker.Start();
        OnPauseChanged(_queue.PauseState, announce: false);

        // Record why the app goes away, so a stopped downloader is never a mystery.
        Microsoft.Win32.SystemEvents.SessionEnding += (_, e) => _exitReason = $"Windows {e.Reason} (sign-out or shutdown)";
        AppDomain.CurrentDomain.UnhandledException += (_, e) => FileLog.Write($"Unhandled exception, app terminating: {e.ExceptionObject}");

        FileLog.Write($"YoutubeHDx app started (pid {Environment.ProcessId})");
    }

    private string _exitReason = "close request from Windows or another program";

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show downloads", null, (_, _) => ShowForm());
        menu.Items.Add("Sync watched playlists now", null, (_, _) =>
        {
            var n = SafeRun(() => _watcher.SyncNow());
            _tray.ShowBalloonTip(3000, "YoutubeHDx", n == 0 ? "Nothing new to queue." : $"Queued {n} playlist(s).", ToolTipIcon.Info);
        });
        menu.Items.Add(new ToolStripSeparator());

        _pauseMenu = new ToolStripMenuItem("Pause downloads");
        foreach (var (label, minutes) in PauseChoices)
            _pauseMenu.DropDownItems.Add(label, null, (_, _) => _queue.Pause(minutes is { } m ? TimeSpan.FromMinutes(m) : null));
        menu.Items.Add(_pauseMenu);
        _resumeItem = new ToolStripMenuItem("Resume downloads", null, (_, _) => _queue.Resume());
        menu.Items.Add(_resumeItem);

        menu.Items.Add(new ToolStripSeparator());
        var subs = new ToolStripMenuItem("Subtitles");
        subs.DropDownItems.Add("Scan subtitles now", null, (_, _) => ScanNow());
        subs.DropDownItems.Add("Mark subtitles as bad…", null, (_, _) => MarkBad());
        subs.DropDownItems.Add("Open bad-subtitles list", null, (_, _) =>
            SafeRun(() => OpenIfExists(BadSubsList.PathIn(SettingsStore.Load().NasPath), "No videos marked yet.")));
        menu.Items.Add(subs);
        var library = new ToolStripMenuItem("Library (Plex)");
        library.DropDownItems.Add("Fix file names and add info files now", null,
            (_, _) => _ = SafeBackground(() => TidyLibraryAsync(announce: true)));
        library.DropDownItems.Add("Find duplicates now", null, (_, _) => _ = SafeBackground(async () =>
        {
            var r = await _duplicates.ScanAsync(_stop.Token);
            _ui.Post(_ => _tray.ShowBalloonTip(6000, "Duplicate check finished",
                $"{r.Duplicates.Count(d => d.State == "ignored")} copies hidden from Plex, {r.Check.Count} to check (Show downloads → Duplicates).", ToolTipIcon.Info), null);
        }));
        library.DropDownItems.Add("TIDAL better-audio playlist: update now", null, (_, _) => _ = UpdateTidalAsync(interactive: true));
        library.DropDownItems.Add("TIDAL: sign out", null, (_, _) => { TidalAuth.SignOut(); _tray.ShowBalloonTip(3000, "YoutubeHDx", "Signed out of TIDAL.", ToolTipIcon.Info); });
        library.DropDownItems.Add("Open renamed-files list", null, (_, _) =>
            SafeRun(() => OpenIfExists(Path.Combine(SettingsStore.Load().NasPath, DatedNameFixer.CsvName), "No files renamed so far.")));
        menu.Items.Add(library);
        menu.Items.Add("Open unavailable-videos list", null, (_, _) =>
            SafeRun(() => OpenIfExists(Path.Combine(SettingsStore.Load().NasPath, UnavailableReporter.CsvName), "No unavailable videos so far.")));

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open NAS folder", null, (_, _) => SafeRun(() => Open(SettingsStore.Load().NasPath)));
        menu.Items.Add("Edit settings…", null, (_, _) => SafeRun(() => { SettingsStore.Load(); Open(AppPaths.SettingsFile); }));
        menu.Items.Add("Open log", null, (_, _) => SafeRun(() => Open(AppPaths.LogFile)));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => { _exitReason = "Exit chosen from the tray menu"; ExitThread(); });
        return menu;
    }

    internal DownloadQueue Queue => _queue;

    // ---------------------------------------------------------------- subtitles

    private void ScanNow()
    {
        _tray.ShowBalloonTip(3000, "YoutubeHDx", "Checking subtitles of downloaded videos…", ToolTipIcon.Info);
        _ = SafeBackground(async () =>
        {
            var summary = await _scanner.ScanAllAsync(_stop.Token);
            _ui.Post(_ => _tray.ShowBalloonTip(6000, "Subtitle scan finished", summary.Describe(), ToolTipIcon.Info), null);
        });
    }

    /// <summary>
    /// Removes the date older versions put in front of file names (it confused Plex), then writes the .nfo/.jpg
    /// files players use for artist, song and picture. Both only touch what still needs it, so this is cheap to repeat.
    /// </summary>
    private async Task TidyLibraryAsync(bool announce)
    {
        var s = SettingsStore.Load();
        var parts = new List<string>();
        if (s.FixDatedFileNames && !s.OutputTemplate.Contains("upload_date", StringComparison.Ordinal))
        {
            var renamed = await Task.Run(() => DatedNameFixer.Fix(s.NasPath, FileLog.Write, _stop.Token));
            if (renamed.Renamed + renamed.Conflicts + renamed.Failed > 0) parts.Add(renamed.Describe());
        }
        if (s.WriteInfoFiles)
        {
            if (announce) _ui.Post(_ => _tray.ShowBalloonTip(3000, "YoutubeHDx", "Adding info files and pictures for Plex…", ToolTipIcon.Info), null);
            var info = await _info.WriteAllAsync(_stop.Token);
            if (info.Nfos + info.Pictures + info.Failed > 0) parts.Add(info.Describe());
        }
        if (s.DuplicateCheck)
        {
            try
            {
                var r = await _duplicates.ScanAsync(_stop.Token);
                if (announce) parts.Add($"{r.Duplicates.Count(d => d.State == "ignored")} duplicate copies hidden, {r.Check.Count} to check");
            }
            catch (InvalidOperationException ex) { FileLog.Write($"Duplicate check skipped: {ex.Message}"); }
        }
        if (s.TidalPlaylist && !string.IsNullOrWhiteSpace(s.TidalClientId) && TidalAuth.Load() is not null)
            await UpdateTidalAsync(interactive: false);
        if (announce || parts.Count > 0)
        {
            var text = parts.Count > 0 ? string.Join("; ", parts) : "Everything was already in order.";
            _ui.Post(_ => _tray.ShowBalloonTip(6000, "Library tidied", text, ToolTipIcon.Info), null);
        }
    }

    /// <summary>
    /// The TIDAL playlist of songs whose TIDAL track has the same length as the video. First time: asks for your
    /// developer.tidal.com Client ID and opens TIDAL's own sign-in page.
    /// </summary>
    private async Task UpdateTidalAsync(bool interactive)
    {
        try
        {
            var s = SettingsStore.Load();
            if (string.IsNullOrWhiteSpace(s.TidalClientId))
            {
                if (!interactive) return;
                MessageBox.Show(
                    "To build the TIDAL playlist, YoutubeHDx uses TIDAL's official API, which needs an app of yours:\n\n" +
                    "1. Open developer.tidal.com, sign in, Dashboard → Create app.\n" +
                    $"2. Add the redirect URI  {TidalAuth.RedirectUri}\n" +
                    "3. Turn on the scopes search.read, playlists.read, playlists.write (and user.read).\n" +
                    "4. Copy the Client ID (not the secret) and paste it in the next box.",
                    "YoutubeHDx — TIDAL", MessageBoxButtons.OK, MessageBoxIcon.Information);
                var id = Prompt.Ask("TIDAL Client ID", "Client ID of your app at developer.tidal.com:");
                if (string.IsNullOrWhiteSpace(id)) return;
                s.TidalClientId = id.Trim();
                SettingsStore.Save(s);
            }

            if (TidalAuth.Load() is null)
            {
                if (!interactive) return;
                _ui.Post(_ => _tray.ShowBalloonTip(5000, "YoutubeHDx", "Sign in to TIDAL in the browser window that opens, and allow access.", ToolTipIcon.Info), null);
                // If the browser can't open the localhost page TIDAL sends it to, the address it shows can be pasted.
                var pasted = new TaskCompletionSource<string?>();
                var signIn = TidalAuth.SignInAsync(Http, s.TidalClientId, url => Open(url), _stop.Token, _ => pasted.Task);
                _ui.Post(_ =>
                {
                    if (signIn.IsCompleted) return;
                    var url = Prompt.Ask("TIDAL sign-in",
                        "After allowing access, if the browser can't open the localhost page, paste its address here (otherwise just close this).");
                    if (!string.IsNullOrWhiteSpace(url)) pasted.TrySetResult(url);
                }, null);
                await signIn;
            }

            if (_duplicates.Results.ScannedAt is null) await _duplicates.ScanAsync(_stop.Token, preview: !s.DuplicateCheck);
            var summary = await Task.Run(() => _tidal.RunAsync(_duplicates.VisibleFiles(), _stop.Token));
            if (interactive || summary.Added > 0)
                _ui.Post(_ => _tray.ShowBalloonTip(8000, "TIDAL playlist updated", summary.Describe() + $" (list: {BetterAudioPlaylist.CsvName})", ToolTipIcon.Info), null);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            FileLog.Write($"TIDAL playlist failed: {ex.Message}");
            if (interactive) _ui.Post(_ => MessageBox.Show(ex.Message, "YoutubeHDx — TIDAL", MessageBoxButtons.OK, MessageBoxIcon.Warning), null);
        }
    }

    private void MarkBad()
    {
        var text = Prompt.Ask("Mark subtitles as bad",
            "Paste the YouTube link (or the video's file name). The scan will add better subtitles;\n" +
            "if those are wrong too, mark it again and it tries another source.");
        if (string.IsNullOrWhiteSpace(text)) return;
        var id = SafeRun(() => BadSubsList.Add(SettingsStore.Load().NasPath, text));
        if (id is null) { MessageBox.Show("That doesn't look like a YouTube link or video file name.", "YoutubeHDx"); return; }
        ScanNow();
    }

    private async Task DailySubtitleScanAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(30), _stop.Token); // let downloads start first after logon
            while (!_stop.IsCancellationRequested)
            {
                var next = TimeSpan.FromHours(Math.Max(1, SettingsStore.Load().SubtitleScanIntervalHours));
                try { await TidyLibraryAsync(announce: false); }
                catch (Exception ex) when (ex is not OperationCanceledException) { FileLog.Write($"Library tidy failed: {ex.Message}"); }
                if (SettingsStore.Load().SubtitleScan)
                {
                    try
                    {
                        var summary = await _scanner.ScanAllAsync(_stop.Token);
                        if (summary.Stopped) next = TimeSpan.FromHours(1); // paused: try again soon
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException) { FileLog.Write($"Subtitle scan failed: {ex.Message}"); }
                }
                await Task.Delay(next, _stop.Token);
            }
        }
        catch (OperationCanceledException) { /* exiting */ }
    }

    private static async Task SafeBackground(Func<Task> work)
    {
        try { await Task.Run(work); }
        catch (OperationCanceledException) { /* exiting */ }
        catch (Exception ex) { FileLog.Write($"Background task failed: {ex}"); }
    }

    private static void OpenIfExists(string path, string emptyMessage)
    {
        if (File.Exists(path)) Open(path);
        else MessageBox.Show(emptyMessage, "YoutubeHDx");
    }

    /// <summary>Pause lengths offered in the tray and the extension. null = until resumed.</summary>
    internal static readonly (string Label, int? Minutes)[] PauseChoices =
    [
        ("For 15 minutes", 15), ("For 1 hour", 60), ("For 3 hours", 180), ("For 8 hours", 480), ("Until I resume", null),
    ];

    private void OnPauseChanged(PauseState state, bool announce)
    {
        _resumeItem.Enabled = state.IsPaused;
        _pauseMenu.Text = state.IsPaused ? "Pause downloads (change)" : "Pause downloads";
        var text = "YoutubeHDx: " + state.Describe();
        _tray.Text = text.Length > 63 ? text[..63] : text; // NotifyIcon limit
        if (announce)
            _tray.ShowBalloonTip(3000, "YoutubeHDx",
                state.IsPaused ? $"{state.Describe()}. Your bandwidth is free." : "Downloads resumed.", ToolTipIcon.Info);
    }

    private IpcResponse HandleIpc(IpcRequest r)
    {
        switch (r.Command)
        {
            case "ping":
                return new IpcResponse(true, "App OK.");

            case "enqueue":
            {
                var (added, job) = _queue.Enqueue(r.Url ?? "", r.NoPlaylist, "extension");
                var what = r.NoPlaylist ? "Video" : "Playlist";
                return new IpcResponse(true, added ? $"{what} queued for 4K download." : $"{what} is already in the queue.",
                    new[] { job.ToSnapshot() });
            }

            case "status":
                return new IpcResponse(true, Jobs: _queue.Snapshot().OrderByDescending(j => j.CreatedAt).Take(25).ToList(),
                    Pause: _queue.PauseState);

            case "pause":
            {
                if (r.Minutes is <= 0) throw new ArgumentException("Pause length must be positive.");
                var state = _queue.Pause(r.Minutes is { } m ? TimeSpan.FromMinutes(m) : null);
                return new IpcResponse(true, state.Describe() + ".", Pause: state);
            }

            case "resume":
                return new IpcResponse(true, "Downloads resumed.", Pause: _queue.Resume());

            case "cancel":
                return r.JobId is { } id && _queue.Cancel(id)
                    ? new IpcResponse(true, "Canceled.")
                    : new IpcResponse(false, "Job not found or already finished.");

            case "watch":
            {
                var url = r.Url ?? throw new ArgumentException("Missing URL.");
                var added = SettingsStore.AddWatchedPlaylist(url);
                _queue.Enqueue(url, noPlaylist: false, source: "watch");
                return new IpcResponse(true, added
                    ? "Playlist added to auto-sync. New videos will be downloaded automatically."
                    : "Playlist is already on auto-sync. Queued a check now.");
            }

            default:
                return new IpcResponse(false, $"Unknown command '{r.Command}'.");
        }
    }

    private void OnJobFinished(DownloadJob job)
    {
        var s = job.ToSnapshot();
        var name = s.Title ?? s.Url;
        switch (s.Status)
        {
            case JobStatus.Completed when s.ItemsCompleted > 0:
                _tray.ShowBalloonTip(4000, "Saved to NAS",
                    s.ItemsCompleted == 1 ? name : $"{s.ItemsCompleted} videos saved", ToolTipIcon.Info);
                break;
            case JobStatus.CompletedWithErrors:
                _tray.ShowBalloonTip(5000, "Finished with errors",
                    $"{s.ItemsCompleted} saved. {s.Error}", ToolTipIcon.Warning);
                break;
            case JobStatus.Failed:
                _tray.ShowBalloonTip(6000, "Download failed", s.Error ?? name, ToolTipIcon.Error);
                break;
        }
    }

    private void ShowForm()
    {
        if (_form is null || _form.IsDisposed) _form = new MainForm(_queue, _board, _duplicates, () => _stop.Token);
        _form.Show();
        if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
        _form.Activate();
    }

    private static void Open(string path) =>
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });

    private T? SafeRun<T>(Func<T> action)
    {
        try { return action(); }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "YoutubeHDx", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return default;
        }
    }

    private void SafeRun(Action action) => SafeRun(() => { action(); return 0; });

    protected override void ExitThreadCore()
    {
        FileLog.Write($"YoutubeHDx app stopping: {_exitReason}");
        _stop.Cancel();
        _pauseTicker.Stop();
        _tray.Visible = false;
        _tray.Dispose();
        _watcher.Dispose();
        _ipc.Dispose();
        _form?.Dispose();
        // Stops workers and kills any running yt-dlp; partial files stay in the temp folder.
        _queue.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(5));
        base.ExitThreadCore();
    }
}
