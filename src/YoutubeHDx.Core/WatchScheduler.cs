namespace YoutubeHDx.Core;

/// <summary>Periodically queues every enabled watched playlist. The archive file makes repeat runs cheap.</summary>
public sealed class WatchScheduler : IDisposable
{
    private readonly DownloadQueue _queue;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _stop = new();

    public WatchScheduler(DownloadQueue queue, Action<string> log)
    {
        _queue = queue;
        _log = log;
        _queue.JobFinished += RememberPlaylistName;
    }

    /// <summary>Saves the playlist's YouTube title as its name, so the downloads window shows it from the start next time.</summary>
    private void RememberPlaylistName(DownloadJob job)
    {
        if (job.Source != "watch" || string.IsNullOrWhiteSpace(job.PlaylistTitle)) return;
        try { SettingsStore.SetPlaylistNameIfMissing(job.Url, job.PlaylistTitle); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException) { _log($"Could not save playlist name: {ex.Message}"); }
    }

    public void Start() => _ = LoopAsync();

    /// <summary>Queues all enabled watched playlists now. Returns how many were newly queued.</summary>
    public int SyncNow()
    {
        var settings = SettingsStore.Load();
        var added = 0;
        foreach (var p in settings.WatchedPlaylists.Where(p => p.Enabled && !string.IsNullOrWhiteSpace(p.Url)))
        {
            try
            {
                if (_queue.Enqueue(p.Url, noPlaylist: false, source: "watch", name: p.Name).Added) added++;
            }
            catch (ArgumentException ex)
            {
                _log($"Skipping watched playlist: {ex.Message}");
            }
        }
        return added;
    }

    private async Task LoopAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), _stop.Token).ConfigureAwait(false); // let the app settle after login
            while (!_stop.IsCancellationRequested)
            {
                var interval = TimeSpan.FromMinutes(360);
                try
                {
                    SyncNow();
                    interval = TimeSpan.FromMinutes(Math.Max(15, SettingsStore.Load().WatchIntervalMinutes));
                }
                catch (Exception ex)
                {
                    _log($"Watched playlist sync failed: {ex.Message}");
                }
                await Task.Delay(interval, _stop.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // stopping
        }
    }

    public void Dispose()
    {
        _queue.JobFinished -= RememberPlaylistName;
        _stop.Cancel();
        _stop.Dispose();
    }
}
