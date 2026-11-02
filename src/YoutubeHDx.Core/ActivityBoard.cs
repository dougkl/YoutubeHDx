using System.Collections.Concurrent;

namespace YoutubeHDx.Core;

/// <summary>A background task shown next to the downloads (subtitle check, Plex info files...).</summary>
public sealed record ActivitySnapshot(
    string Key, string Name, bool Running, int Done, int Total, string? Current, string? Summary, DateTimeOffset UpdatedAt)
{
    public double Percent => Total > 0 ? 100.0 * Done / Total : 0;

    public string StatusText => Running
        ? (Total > 0 ? $"Checking {Math.Min(Done + 1, Total)} of {Total}" : "Working")
        : "Idle";
}

/// <summary>Thread-safe list of background tasks and how far along they are.</summary>
public sealed class ActivityBoard
{
    private readonly ConcurrentDictionary<string, ActivitySnapshot> _items = new();

    public void Start(string key, string name, int total, string? current = null) =>
        _items[key] = new ActivitySnapshot(key, name, true, 0, total, current, Get(key)?.Summary, DateTimeOffset.Now);

    public void Progress(string key, int done, string? current)
    {
        if (Get(key) is { } a) _items[key] = a with { Done = done, Current = current, UpdatedAt = DateTimeOffset.Now };
    }

    /// <summary>Marks the task idle with a result line, e.g. "Last check 15:04: 865 checked, 2 lyrics added".</summary>
    public void Finish(string key, string name, string summary) =>
        _items[key] = new ActivitySnapshot(key, name, false, 0, 0, null, summary, DateTimeOffset.Now);

    /// <summary>Updates only the result line (e.g. after checking one new download) unless a full run is going on.</summary>
    public void Note(string key, string name, string summary)
    {
        var a = Get(key);
        _items[key] = a is { Running: true }
            ? a with { UpdatedAt = DateTimeOffset.Now }
            : new ActivitySnapshot(key, name, false, 0, 0, null, summary, DateTimeOffset.Now);
    }

    public ActivitySnapshot? Get(string key) => _items.TryGetValue(key, out var a) ? a : null;

    public IReadOnlyList<ActivitySnapshot> Snapshot() => _items.Values.OrderBy(a => a.Key, StringComparer.Ordinal).ToList();
}
