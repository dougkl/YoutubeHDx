using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace YoutubeHDx.Core;

/// <summary>In-memory FIFO of download jobs processed by a fixed number of workers, with pause/resume.</summary>
public sealed class DownloadQueue : IAsyncDisposable
{
    private const int MaxHistory = 200;

    private readonly Channel<DownloadJob> _channel = Channel.CreateUnbounded<DownloadJob>();
    private readonly ConcurrentDictionary<Guid, CancellationTokenSource> _running = new();
    private readonly List<DownloadJob> _jobs = new();
    private readonly object _jobsGate = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly List<Task> _workers = new();
    private readonly YtDlpRunner _runner;
    private readonly Action<string> _log;

    // Pause state. _pauseGate also guards "start a job", so a pause can never slip between check and start.
    private readonly object _pauseGate = new();
    private PauseState _pause;
    private CancellationTokenSource _pauseCts = new();
    private TaskCompletionSource _resumed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public DownloadQueue(Action<string> log)
    {
        _log = log;
        _runner = new YtDlpRunner(log);
        _pause = PauseStore.Load();
        if (_pause.IsPaused) _log($"Starting paused: {_pause.Describe()}");
        RestoreQueue();
    }

    /// <summary>Raised on a worker thread when a job reaches a final state.</summary>
    public event Action<DownloadJob>? JobFinished;

    /// <summary>Raised whenever downloads are paused or resume (including when a timed pause runs out).</summary>
    public event Action<PauseState>? PauseChanged;

    public void Start(int workerCount)
    {
        for (var i = 0; i < Math.Clamp(workerCount, 1, 4); i++)
            _workers.Add(Task.Run(WorkerAsync));
    }

    // ---------------------------------------------------------------- pause / resume

    /// <summary>Current pause state. Reading it also ends a timed pause whose time is up.</summary>
    public PauseState PauseState
    {
        get
        {
            ExpirePauseIfDue();
            lock (_pauseGate) return _pause;
        }
    }

    /// <summary>
    /// Pauses downloads for <paramref name="duration"/>, or until <see cref="Resume"/> when null.
    /// The running download stops at once; it continues from its partial file when downloads resume.
    /// </summary>
    public PauseState Pause(TimeSpan? duration)
    {
        if (duration is { } d && d <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(duration));
        PauseState state;
        lock (_pauseGate)
        {
            state = new PauseState(true, duration is { } dd ? DateTimeOffset.Now + dd : null);
            _pause = state;
            var old = _pauseCts;
            _pauseCts = new CancellationTokenSource();
            old.Cancel(); // stops whatever is downloading right now
            old.Dispose();
        }
        PauseStore.Save(state);
        _log($"Downloads paused: {state.Describe()}");
        PauseChanged?.Invoke(state);
        return state;
    }

    public PauseState Resume() => Resume("resumed");

    private PauseState Resume(string why)
    {
        lock (_pauseGate)
        {
            if (!_pause.IsPaused) return _pause;
            _pause = PauseState.Running;
            var waiting = _resumed;
            _resumed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            waiting.TrySetResult();
        }
        PauseStore.Save(PauseState.Running);
        _log($"Downloads {why}");
        PauseChanged?.Invoke(PauseState.Running);
        return PauseState.Running;
    }

    private void ExpirePauseIfDue()
    {
        bool due;
        lock (_pauseGate) due = _pause is { IsPaused: true, Until: { } u } && u <= DateTimeOffset.Now;
        if (due) Resume("resumed (pause time is up)");
    }

    private async Task WaitWhilePausedAsync(CancellationToken ct)
    {
        while (true)
        {
            ExpirePauseIfDue();
            Task resumed;
            TimeSpan wait;
            lock (_pauseGate)
            {
                if (!_pause.IsPaused) return;
                resumed = _resumed.Task;
                wait = _pause.Until is { } u ? (u - DateTimeOffset.Now) + TimeSpan.FromMilliseconds(50) : Timeout.InfiniteTimeSpan;
            }
            if (wait < TimeSpan.Zero) wait = TimeSpan.Zero;
            await Task.WhenAny(resumed, Task.Delay(wait, ct)).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
        }
    }

    // ---------------------------------------------------------------- jobs

    /// <summary>Queues a URL. If the same URL is already queued or running, returns that job instead.</summary>
    public (bool Added, DownloadJob Job) Enqueue(string url, bool noPlaylist, string source)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http"))
            throw new ArgumentException($"Not a valid URL: {url}", nameof(url));

        lock (_jobsGate)
        {
            var existing = _jobs.FirstOrDefault(j => j.IsActive && j.NoPlaylist == noPlaylist &&
                                                     string.Equals(j.Url, url, StringComparison.OrdinalIgnoreCase));
            if (existing is not null) return (false, existing);

            var job = new DownloadJob { Url = url, NoPlaylist = noPlaylist, Source = source };
            _jobs.Add(job);
            TrimHistory();
            _channel.Writer.TryWrite(job);
            _log($"Queued ({source}): {url}");
            SaveQueue();
            return (true, job);
        }
    }

    public IReadOnlyList<JobSnapshot> Snapshot()
    {
        lock (_jobsGate) return _jobs.Select(j => j.ToSnapshot()).ToList();
    }

    public bool Cancel(Guid id)
    {
        DownloadJob? job;
        lock (_jobsGate) job = _jobs.FirstOrDefault(j => j.Id == id);
        if (job is null) return false;
        if (job.TryCancelQueued()) { SaveQueue(); JobFinished?.Invoke(job); return true; }
        if (_running.TryGetValue(id, out var cts))
        {
            job.CancelRequested = true;
            cts.Cancel();
            return true;
        }
        return false;
    }

    public void ClearFinished()
    {
        lock (_jobsGate) _jobs.RemoveAll(j => j.IsFinished);
    }

    // ---------------------------------------------------------------- crash/restart recovery

    private sealed record PendingJob(string Url, bool NoPlaylist, string Source);

    /// <summary>Writes every unfinished job to queue.json (atomically), so a crash loses nothing.</summary>
    private void SaveQueue()
    {
        try
        {
            List<PendingJob> pending;
            lock (_jobsGate)
                pending = _jobs.Where(j => j.IsActive).Select(j => new PendingJob(j.Url, j.NoPlaylist, j.Source)).ToList();
            AppPaths.EnsureDataDir();
            var tmp = AppPaths.QueueFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(pending, Json.Options));
            File.Move(tmp, AppPaths.QueueFile, overwrite: true);
        }
        catch (IOException ex)
        {
            _log($"Could not save the queue: {ex.Message}");
        }
    }

    private void RestoreQueue()
    {
        List<PendingJob>? pending = null;
        try
        {
            if (File.Exists(AppPaths.QueueFile))
                pending = JsonSerializer.Deserialize<List<PendingJob>>(File.ReadAllText(AppPaths.QueueFile), Json.Options);
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            _log($"Could not read the saved queue: {ex.Message}");
        }
        if (pending is not { Count: > 0 }) return;

        _log($"Restoring {pending.Count} unfinished job(s) from before the last stop");
        foreach (var p in pending)
        {
            try { Enqueue(p.Url, p.NoPlaylist, p.Source); }
            catch (ArgumentException ex) { _log($"Skipping saved job: {ex.Message}"); }
        }
    }

    private void TrimHistory()
    {
        var excess = _jobs.Count - MaxHistory;
        if (excess <= 0) return;
        var removable = _jobs.Where(j => j.IsFinished).Take(excess).ToList();
        foreach (var j in removable) _jobs.Remove(j);
    }

    private async Task WorkerAsync()
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(_stop.Token).ConfigureAwait(false))
            {
                // ReadAllAsync keeps yielding already-buffered jobs after cancellation; never start one while stopping.
                if (_stop.IsCancellationRequested) break;
                if (job.Status == JobStatus.Canceled) continue;

                if (!await RunUntilFinishedAsync(job).ConfigureAwait(false)) continue;
                // On shutdown the job stays in queue.json so it runs again after the restart.
                if (!_stop.IsCancellationRequested) SaveQueue();

                try { JobFinished?.Invoke(job); }
                catch (Exception ex) { _log($"JobFinished handler threw: {ex}"); }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            // shutting down
        }
    }

    /// <summary>Runs a job, waiting out pauses (and re-running it after one). True if this call finished the job.</summary>
    private async Task<bool> RunUntilFinishedAsync(DownloadJob job)
    {
        while (true)
        {
            await WaitWhilePausedAsync(_stop.Token).ConfigureAwait(false);
            if (job.Status == JobStatus.Canceled) return false; // canceled while waiting; Cancel() already reported it

            CancellationTokenSource cts;
            lock (_pauseGate)
            {
                if (_pause.IsPaused) continue; // paused again between the wait and now
                cts = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, _pauseCts.Token);
                _running[job.Id] = cts;
                job.MarkRunning();
            }

            try
            {
                var settings = SettingsStore.Load(); // re-read each job so edits apply without restart
                var exitCode = await _runner.RunAsync(job, settings, cts.Token).ConfigureAwait(false);
                job.MarkFinished(exitCode == 0 ? JobStatus.Completed
                    : job.ItemsCompleted > 0 ? JobStatus.CompletedWithErrors
                    : JobStatus.Failed);
                if (exitCode != 0 && job.Error is null) job.SetError($"yt-dlp exited with code {exitCode}. See the log.");
                return true;
            }
            catch (OperationCanceledException)
            {
                if (_stop.IsCancellationRequested)
                {
                    job.MarkFinished(JobStatus.Canceled);
                    _log($"Job {job.Id} stopped because the app is shutting down (it will run again on the next sync)");
                    return true;
                }
                if (job.CancelRequested)
                {
                    job.MarkFinished(JobStatus.Canceled);
                    _log($"Job {job.Id} canceled by user");
                    return true;
                }
                job.MarkPaused();
                _log($"Job {job.Id} paused; it continues from where it stopped when downloads resume");
                // loop: wait for resume, then run it again
            }
            catch (Exception ex)
            {
                job.SetError(ex.Message);
                job.MarkFinished(JobStatus.Failed);
                _log($"Job {job.Id} failed: {ex}");
                return true;
            }
            finally
            {
                _running.TryRemove(job.Id, out _);
                cts.Dispose();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        _stop.Cancel();
        try { await Task.WhenAll(_workers).ConfigureAwait(false); } catch { /* workers log their own errors */ }
        _stop.Dispose();
    }
}
