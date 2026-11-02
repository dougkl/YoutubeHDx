using System.Globalization;
using YoutubeHDx.Core.Subtitles;

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
    DateTimeOffset CreatedAt,
    string? PlaylistTitle = null,
    DateTimeOffset? UpdatedAt = null,
    // What the downloads window and the extension show (plain words, no yt-dlp jargon).
    string? Name = null,
    bool IsPlaylist = false,
    string? StatusText = null,
    string? Summary = null,
    string? Subtitles = null,
    int UnavailableCount = 0,
    int ErrorCount = 0,
    int? PlaylistIndex = null,
    int? PlaylistCount = null);

/// <summary>One yt-dlp invocation: a single video or a whole playlist.</summary>
public sealed class DownloadJob
{
    private readonly object _gate = new();

    public Guid Id { get; } = Guid.NewGuid();
    public required string Url { get; init; }
    public bool NoPlaylist { get; init; }
    public string Source { get; init; } = "manual";
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.Now;

    /// <summary>Name to show before yt-dlp reports the playlist's title (e.g. the watched playlist's name).</summary>
    public string? DisplayName { get; init; }

    /// <summary>Short result of the previous run of the same URL (shown while this one waits).</summary>
    public string? PreviousResult { get; init; }

    public JobStatus Status { get; private set; } = JobStatus.Queued;
    public string? Title { get; private set; }
    public double Percent { get; private set; }
    public string? Speed { get; private set; }
    public string? Eta { get; private set; }
    public int ItemsCompleted { get; private set; }
    public string? LastFile { get; private set; }

    /// <summary>The last real error (not a removed/blocked video, those are counted in <see cref="Unavailable"/>).</summary>
    public string? Error { get; private set; }
    public int ErrorCount { get; private set; }
    public string? PlaylistTitle { get; private set; }
    public int? PlaylistIndex { get; private set; }
    public int? PlaylistCount { get; private set; }

    /// <summary>True once yt-dlp got through the whole playlist (it printed the end-of-playlist line).</summary>
    public bool PlaylistFinished { get; private set; }

    /// <summary>When anything about this job last changed (shown as "Last update").</summary>
    public DateTimeOffset UpdatedAt { get; private set; } = DateTimeOffset.Now;

    public bool IsActive => Status is JobStatus.Queued or JobStatus.Running or JobStatus.Paused;

    /// <summary>Set when the user cancels a running job, to tell it apart from a pause or shutdown.</summary>
    internal bool CancelRequested { get; set; }
    public bool IsFinished => !IsActive;

    private void Touch() => UpdatedAt = DateTimeOffset.Now;

    internal void MarkRunning() { lock (_gate) { Status = JobStatus.Running; Touch(); } }

    internal void MarkFinished(JobStatus status)
    {
        lock (_gate)
        {
            Status = status;
            Speed = null;
            Eta = null;
            if (status == JobStatus.Completed) Percent = 100;
            Touch();
        }
    }

    internal void MarkPaused()
    {
        lock (_gate) { Status = JobStatus.Paused; Speed = null; Eta = null; Touch(); }
    }

    internal bool TryCancelQueued()
    {
        lock (_gate)
        {
            if (Status is not (JobStatus.Queued or JobStatus.Paused)) return false;
            Status = JobStatus.Canceled;
            Touch();
            return true;
        }
    }

    internal void ItemStarted(string title, string? playlistTitle = null, int? index = null, int? count = null)
    {
        lock (_gate)
        {
            Title = title;
            Percent = 0;
            if (!string.IsNullOrWhiteSpace(playlistTitle) && playlistTitle != "NA") PlaylistTitle = playlistTitle;
            if (index is not null) PlaylistIndex = index;
            if (count is not null) PlaylistCount = count;
            Touch();
        }
    }

    internal void PlaylistDone(string? title, int? count)
    {
        lock (_gate)
        {
            PlaylistFinished = true;
            if (!string.IsNullOrWhiteSpace(title) && title != "NA") PlaylistTitle = title;
            if (count is not null) PlaylistCount = count;
            Touch();
        }
    }

    internal void ReportProgress(double percent, string? speed, string? eta)
    {
        lock (_gate) { Percent = percent; Speed = speed; Eta = eta; Touch(); }
    }

    internal void ItemCompleted(string file)
    {
        lock (_gate) { ItemsCompleted++; LastFile = file; Touch(); }
    }

    private readonly List<UnavailableVideo> _unavailable = new();

    /// <summary>Videos this job couldn't get because they're removed, private, blocked... (for the CSV).</summary>
    public IReadOnlyList<UnavailableVideo> Unavailable { get { lock (_gate) return _unavailable.ToList(); } }

    internal void AddUnavailable(UnavailableVideo v) { lock (_gate) { _unavailable.Add(v); Touch(); } }

    internal void SetError(string error)
    {
        lock (_gate) { Error = error; ErrorCount++; Touch(); }
    }

    // ---------------------------------------------------------------- subtitles of the saved videos

    private int _subsOk, _subsAdded, _subsMissing;

    /// <summary>Result of checking the subtitles of a video this job saved.</summary>
    public void AddSubtitleOutcome(ScanOutcome outcome)
    {
        lock (_gate)
        {
            switch (outcome)
            {
                case ScanOutcome.Good or ScanOutcome.Unchanged: _subsOk++; break;
                case ScanOutcome.Fixed: _subsAdded++; break;
                case ScanOutcome.NotFound: _subsMissing++; break;
                default: return;
            }
            Touch();
        }
    }

    private string? SubtitlesText()
    {
        if (_subsOk + _subsAdded + _subsMissing == 0) return null;
        var parts = new List<string>();
        if (_subsOk > 0) parts.Add($"{_subsOk} OK");
        if (_subsAdded > 0) parts.Add($"{_subsAdded} lyrics added");
        if (_subsMissing > 0) parts.Add($"{_subsMissing} none found");
        return string.Join(", ", parts);
    }

    // ---------------------------------------------------------------- plain-words status

    private bool IsPlaylist => !NoPlaylist;

    private string NameText() =>
        NoPlaylist ? Title ?? DisplayName ?? Url : PlaylistTitle ?? DisplayName ?? Url;

    private string StatusTextUnlocked() => Status switch
    {
        JobStatus.Queued => "Waiting",
        JobStatus.Running when Title is null => IsPlaylist ? "Checking for new videos" : "Starting",
        JobStatus.Running when IsPlaylist && PlaylistIndex is { } i && PlaylistCount is { } n => $"Downloading #{i} of {n}",
        JobStatus.Running => "Downloading",
        JobStatus.Paused => "Paused",
        JobStatus.Completed when ItemsCompleted == 0 => IsPlaylist ? "Up to date" : "Already downloaded",
        JobStatus.Completed => ItemsCompleted == 1 ? "Done: 1 new" : $"Done: {ItemsCompleted} new",
        JobStatus.CompletedWithErrors => ItemsCompleted > 0 ? $"Done: {ItemsCompleted} new, some failed" : "Checked, some failed",
        JobStatus.Failed => "Failed",
        JobStatus.Canceled => "Stopped",
        _ => Status.ToString(),
    };

    /// <summary>The result in a few words, e.g. "2 new, 3 unavailable" (used for the next run's "last time").</summary>
    private string ResultUnlocked()
    {
        if (Status == JobStatus.Failed) return "failed: " + FailureText();
        if (Status == JobStatus.Canceled) return "stopped";
        var parts = new List<string> { ItemsCompleted == 0 ? (IsPlaylist ? "up to date" : "already downloaded") : $"{ItemsCompleted} new" };
        if (_unavailable.Count > 0) parts.Add($"{_unavailable.Count} unavailable");
        if (ErrorCount > 0) parts.Add($"{ErrorCount} failed");
        return string.Join(", ", parts);
    }

    private string SummaryUnlocked()
    {
        switch (Status)
        {
            case JobStatus.Queued:
                return PreviousResult is { } prev ? $"Last run {prev}" : "Waiting for its turn";
            case JobStatus.Running:
                return Title is null
                    ? (IsPlaylist ? "Going through the playlist; videos you already have are skipped" : "Getting video details")
                    : Title;
            case JobStatus.Paused:
                return "Continues where it stopped when downloads resume";
            case JobStatus.Canceled:
                return "Stopped before it finished; it runs again on the next sync";
            case JobStatus.Failed:
                return FailureText();
        }

        var parts = new List<string>();
        if (IsPlaylist && PlaylistCount is { } n) parts.Add($"{n} videos in the playlist");
        parts.Add(ItemsCompleted switch
        {
            0 => IsPlaylist ? "nothing new" : "you already have it",
            1 => "1 new video saved",
            var k => $"{k} new videos saved",
        });
        if (_unavailable.Count > 0) parts.Add($"{_unavailable.Count} unavailable on YouTube (see the unavailable-videos list)");
        if (ErrorCount > 0) parts.Add($"{ErrorCount} could not be downloaded: {FriendlyError.Describe(Error)}");
        return string.Join(" · ", parts);
    }

    private string FailureText() =>
        Error is null && _unavailable.Count > 0
            ? $"Unavailable on YouTube ({_unavailable[^1].Category}): {_unavailable[^1].Details}"
            : FriendlyError.Describe(Error);

    /// <summary>"15:04 · 2 new, 3 unavailable"</summary>
    internal string ShortResult()
    {
        lock (_gate)
        {
            var at = UpdatedAt.ToLocalTime();
            var when = at.Date == DateTime.Today ? at.ToString("HH:mm", CultureInfo.InvariantCulture)
                                                 : at.ToString("MMM d HH:mm", CultureInfo.InvariantCulture);
            return $"{when}: {ResultUnlocked()}";
        }
    }

    public JobSnapshot ToSnapshot()
    {
        lock (_gate)
            return new JobSnapshot(Id, Url, Status, Title, Percent, Speed, Eta, ItemsCompleted, LastFile, Error, Source, CreatedAt,
                PlaylistTitle, UpdatedAt,
                NameText(), IsPlaylist, StatusTextUnlocked(), SummaryUnlocked(), SubtitlesText(),
                _unavailable.Count, ErrorCount, PlaylistIndex, PlaylistCount);
    }
}
