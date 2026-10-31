using System.Diagnostics;
using YoutubeHDx.Core;

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
        menu.Items.Add("Open NAS folder", null, (_, _) => SafeRun(() => Open(SettingsStore.Load().NasPath)));
        menu.Items.Add("Edit settings…", null, (_, _) => SafeRun(() => { SettingsStore.Load(); Open(AppPaths.SettingsFile); }));
        menu.Items.Add("Open log", null, (_, _) => SafeRun(() => Open(AppPaths.LogFile)));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => { _exitReason = "Exit chosen from the tray menu"; ExitThread(); });
        return menu;
    }

    internal DownloadQueue Queue => _queue;

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
                return new IpcResponse(true, Jobs: _queue.Snapshot().OrderByDescending(j => j.CreatedAt).Take(25).ToList());

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
        if (_form is null || _form.IsDisposed) _form = new MainForm(_queue);
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
