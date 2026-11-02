namespace YoutubeHDx.Core;

/// <summary>Paused = interrupted by a pause; it runs again (resuming partial files) when downloads resume.</summary>
public enum JobStatus { Queued, Running, Paused, Completed, CompletedWithErrors, Failed, Canceled }

public sealed record JobSnapshot(
    Guid Id,
    string Url,
    JobStatus Status,
    string? Title,
    double Percent,
    string? Speed,
    string? Eta,
    int ItemsCompleted,
    string? LastFile,
    string? Error,
    string Source,
    DateTimeOffset CreatedAt);

/// <summary>One yt-dlp invocation: a single video or a whole playlist.</summary>
public sealed class DownloadJob
{
    private readonly object _gate = new();

    public Guid Id { get; } = Guid.NewGuid();
    public required string Url { get; init; }
    public bool NoPlaylist { get; init; }
    public string Source { get; init; } = "manual";
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.Now;

    public JobStatus Status { get; private set; } = JobStatus.Queued;
    public string? Title { get; private set; }
    public double Percent { get; private set; }
    public string? Speed { get; private set; }
    public string? Eta { get; private set; }
    public int ItemsCompleted { get; private set; }
    public string? LastFile { get; private set; }
    public string? Error { get; private set; }

    public bool IsActive => Status is JobStatus.Queued or JobStatus.Running or JobStatus.Paused;

    /// <summary>Set when the user cancels a running job, to tell it apart from a pause or shutdown.</summary>
    internal bool CancelRequested { get; set; }
    public bool IsFinished => !IsActive;

    internal void MarkRunning() { lock (_gate) Status = JobStatus.Running; }

    internal void MarkFinished(JobStatus status)
    {
        lock (_gate)
        {
            Status = status;
            Speed = null;
            Eta = null;
            if (status == JobStatus.Completed) Percent = 100;
        }
    }

    internal void MarkPaused()
    {
        lock (_gate) { Status = JobStatus.Paused; Speed = null; Eta = null; }
    }

    internal bool TryCancelQueued()
    {
        lock (_gate)
        {
            if (Status is not (JobStatus.Queued or JobStatus.Paused)) return false;
            Status = JobStatus.Canceled;
            return true;
        }
    }

    internal void ItemStarted(string title)
    {
        lock (_gate) { Title = title; Percent = 0; }
    }

    internal void ReportProgress(double percent, string? speed, string? eta)
    {
        lock (_gate) { Percent = percent; Speed = speed; Eta = eta; }
    }

    internal void ItemCompleted(string file)
    {
        lock (_gate) { ItemsCompleted++; LastFile = file; }
    }

    private readonly List<UnavailableVideo> _unavailable = new();

    /// <summary>Videos this job couldn't get because they're removed, private, blocked... (for the CSV).</summary>
    public IReadOnlyList<UnavailableVideo> Unavailable { get { lock (_gate) return _unavailable.ToList(); } }

    internal void AddUnavailable(UnavailableVideo v) { lock (_gate) _unavailable.Add(v); }

    internal void SetError(string error)
    {
        lock (_gate) Error = error;
    }

    public JobSnapshot ToSnapshot()
    {
        lock (_gate)
            return new JobSnapshot(Id, Url, Status, Title, Percent, Speed, Eta, ItemsCompleted, LastFile, Error, Source, CreatedAt);
    }
}
