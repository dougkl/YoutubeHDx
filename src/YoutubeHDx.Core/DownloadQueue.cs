using System.Collections.Concurrent;
using System.Threading.Channels;

namespace YoutubeHDx.Core;

/// <summary>In-memory FIFO of download jobs processed by a fixed number of workers.</summary>
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

    public DownloadQueue(Action<string> log)
    {
        _log = log;
        _runner = new YtDlpRunner(log);
    }

    /// <summary>Raised on a worker thread when a job reaches a final state.</summary>
    public event Action<DownloadJob>? JobFinished;

    public void Start(int workerCount)
    {
        for (var i = 0; i < Math.Clamp(workerCount, 1, 4); i++)
            _workers.Add(Task.Run(WorkerAsync));
    }

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
        if (job.TryCancelQueued()) { JobFinished?.Invoke(job); return true; }
        if (_running.TryGetValue(id, out var cts)) { cts.Cancel(); return true; }
        return false;
    }

    public void ClearFinished()
    {
        lock (_jobsGate) _jobs.RemoveAll(j => j.IsFinished);
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

                using var cts = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                _running[job.Id] = cts;
                job.MarkRunning();
                try
                {
                    var settings = SettingsStore.Load(); // re-read each job so edits apply without restart
                    var exitCode = await _runner.RunAsync(job, settings, cts.Token).ConfigureAwait(false);
                    job.MarkFinished(exitCode == 0 ? JobStatus.Completed
                        : job.ItemsCompleted > 0 ? JobStatus.CompletedWithErrors
                        : JobStatus.Failed);
                    if (exitCode != 0 && job.Error is null) job.SetError($"yt-dlp exited with code {exitCode}. See the log.");
                }
                catch (OperationCanceledException)
                {
                    job.MarkFinished(JobStatus.Canceled);
                    _log(_stop.IsCancellationRequested
                        ? $"Job {job.Id} stopped because the app is shutting down (it will run again on the next sync)"
                        : $"Job {job.Id} canceled by user");
                }
                catch (Exception ex)
                {
                    job.SetError(ex.Message);
                    job.MarkFinished(JobStatus.Failed);
                    _log($"Job {job.Id} failed: {ex}");
                }
                finally
                {
                    _running.TryRemove(job.Id, out _);
                }

                try { JobFinished?.Invoke(job); }
                catch (Exception ex) { _log($"JobFinished handler threw: {ex}"); }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            // shutting down
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
