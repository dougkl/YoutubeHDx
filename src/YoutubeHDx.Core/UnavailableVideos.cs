using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace YoutubeHDx.Core;

/// <summary>A video yt-dlp could not get because it is gone or blocked (not a temporary error).</summary>
public sealed record UnavailableVideo(string Id, string Category, string Details);

/// <summary>Title/channel/playlist for a playlist entry, from a flat playlist listing.</summary>
public sealed record PlaylistEntry(string Id, string? Title, string? Channel, string? Playlist);

public static partial class UnavailableVideos
{
    [GeneratedRegex(@"^ERROR: \[youtube(?::[\w]+)?\] ([\w-]{11}): (.+)$")]
    private static partial Regex ErrorLine();

    private static readonly (string Category, Regex Pattern)[] Categories =
    [
        ("removed", new Regex(@"removed by the uploader|has been removed|no longer available|account .* terminated|video has been deleted", RegexOptions.IgnoreCase)),
        ("copyright", new Regex(@"copyright", RegexOptions.IgnoreCase)),
        ("blocked in your country", new Regex(@"(available in your country|blocked it in your country|geo.?restrict)", RegexOptions.IgnoreCase)),
        ("private", new Regex(@"private video", RegexOptions.IgnoreCase)),
        ("members only", new Regex(@"members.only|join this channel", RegexOptions.IgnoreCase)),
        ("age restricted", new Regex(@"confirm your age|age.restricted|inappropriate for some users", RegexOptions.IgnoreCase)),
        ("unavailable", new Regex(@"^video unavailable", RegexOptions.IgnoreCase)),
    ];

    /// <summary>
    /// Parses a yt-dlp error line. Returns null for anything that isn't about the video itself being gone or
    /// blocked (network trouble, "confirm you're not a bot", HTTP errors...), so the CSV only lists real losses.
    /// </summary>
    public static UnavailableVideo? Parse(string line)
    {
        var m = ErrorLine().Match(line.Trim());
        if (!m.Success) return null;
        var details = m.Groups[2].Value.Trim();
        if (Regex.IsMatch(details, @"not a bot|HTTP Error|timed out|unable to download|network|connection", RegexOptions.IgnoreCase))
            return null;
        foreach (var (category, pattern) in Categories)
            if (pattern.IsMatch(details)) return new UnavailableVideo(m.Groups[1].Value, category, details);
        return null;
    }
}

/// <summary>
/// Appends unavailable videos to "unavailable-videos.csv" in the download folder, each video once, so you can
/// look for them elsewhere. Append-only (the NAS share allows adding, not editing).
/// </summary>
public sealed class UnavailableReporter
{
    public const string CsvName = "unavailable-videos.csv";
    private const string Header = "first_seen,video_id,youtube_link,title,channel,playlist,reason,details";

    private readonly Func<AppSettings> _settings;
    private readonly Func<AppSettings, string, CancellationToken, Task<IReadOnlyDictionary<string, PlaylistEntry>>> _lookup;
    private readonly Action<string> _log;
    private readonly Func<DateTimeOffset> _now;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public UnavailableReporter(Func<AppSettings> settings,
        Func<AppSettings, string, CancellationToken, Task<IReadOnlyDictionary<string, PlaylistEntry>>>? lookup,
        Action<string> log, Func<DateTimeOffset>? now = null)
    {
        _settings = settings;
        _lookup = lookup ?? FlatListAsync;
        _log = log;
        _now = now ?? (() => DateTimeOffset.Now);
    }

    /// <summary>Records the unavailable videos a job ran into. Returns how many new rows were added.</summary>
    public async Task<int> ReportAsync(DownloadJob job, CancellationToken ct)
    {
        var found = job.Unavailable;
        if (found.Count == 0) return 0;
        var s = _settings();
        if (!s.ReportUnavailable || !Directory.Exists(s.NasPath)) return 0;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var reported = LoadReported();
            var fresh = found.Where(v => !reported.Contains(v.Id)).GroupBy(v => v.Id).Select(g => g.First()).ToList();
            if (fresh.Count == 0) return 0;

            // Titles help you find the video elsewhere; the playlist listing still shows most of them.
            IReadOnlyDictionary<string, PlaylistEntry> entries = new Dictionary<string, PlaylistEntry>();
            if (!job.NoPlaylist)
            {
                try { entries = await _lookup(s, job.Url, ct).ConfigureAwait(false); }
                catch (Exception e) when (e is not OperationCanceledException) { _log($"Could not list playlist titles: {e.Message}"); }
            }

            var csv = Path.Combine(s.NasPath, CsvName);
            var sb = new StringBuilder();
            var isNew = !File.Exists(csv);
            if (isNew) sb.Append(Header).Append("\r\n");
            foreach (var v in fresh)
            {
                entries.TryGetValue(v.Id, out var e);
                var title = e?.Title is { } t && !t.StartsWith('[') ? t : null; // "[Deleted video]" carries no information
                sb.Append(string.Join(',', new[]
                {
                    _now().ToString("yyyy-MM-dd HH:mm"), v.Id, $"https://www.youtube.com/watch?v={v.Id}",
                    title ?? "", e?.Channel ?? "", e?.Playlist ?? "", v.Category, v.Details,
                }.Select(Csv))).Append("\r\n");
            }

            // UTF-8 with BOM on creation so Excel shows accents correctly; appended rows are plain UTF-8.
            var bytes = (isNew ? new UTF8Encoding(true).GetPreamble() : []).Concat(new UTF8Encoding(false).GetBytes(sb.ToString())).ToArray();
            using (var fs = new FileStream(csv, FileMode.Append, FileAccess.Write))
                await fs.WriteAsync(bytes, ct).ConfigureAwait(false);

            foreach (var v in fresh) reported.Add(v.Id);
            SaveReported(reported);
            _log($"Listed {fresh.Count} unavailable video(s) in {CsvName}");
            return fresh.Count;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string Csv(string? value)
    {
        var v = (value ?? "").Replace("\r", " ").Replace("\n", " ");
        if (v.Length > 0 && "=+-@".Contains(v[0])) v = "'" + v; // stop spreadsheets treating text as a formula
        return v.IndexOfAny([',', '"']) >= 0 || v != v.Trim() ? $"\"{v.Replace("\"", "\"\"")}\"" : v;
    }

    private static HashSet<string> LoadReported()
    {
        try
        {
            if (File.Exists(AppPaths.UnavailableStateFile))
                return JsonSerializer.Deserialize<HashSet<string>>(File.ReadAllText(AppPaths.UnavailableStateFile)) ?? new();
        }
        catch (Exception e) when (e is IOException or JsonException) { /* start over */ }
        return new();
    }

    private static void SaveReported(HashSet<string> ids)
    {
        AppPaths.EnsureDataDir();
        File.WriteAllText(AppPaths.UnavailableStateFile, JsonSerializer.Serialize(ids));
    }

    /// <summary>yt-dlp --flat-playlist: one fast request for every entry's id, title and channel.</summary>
    public static async Task<IReadOnlyDictionary<string, PlaylistEntry>> FlatListAsync(AppSettings s, string url, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(s.YtDlpPath)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var a in new[]
                 {
                     "--encoding", "utf-8", "--flat-playlist", "--no-warnings", "--ignore-errors",
                     "--print", "%(id)s\t%(title)s\t%(channel,uploader|)s\t%(playlist_title|)s",
                 })
            psi.ArgumentList.Add(a);
        if (File.Exists(AppPaths.CookiesFile)) { psi.ArgumentList.Add("--cookies"); psi.ArgumentList.Add(AppPaths.CookiesFile); }
        psi.ArgumentList.Add("--");
        psi.ArgumentList.Add(url);
        psi.Environment["PYTHONIOENCODING"] = "utf-8";

        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync(ct);
        _ = p.StandardError.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct).ConfigureAwait(false);

        var map = new Dictionary<string, PlaylistEntry>(StringComparer.Ordinal);
        foreach (var line in (await stdout.ConfigureAwait(false)).Split('\n'))
        {
            var cols = line.TrimEnd('\r').Split('\t');
            if (cols.Length < 4 || cols[0].Length != 11) continue;
            static string? N(string v) => string.IsNullOrWhiteSpace(v) || v == "NA" ? null : v.Trim();
            map[cols[0]] = new PlaylistEntry(cols[0], N(cols[1]), N(cols[2]), N(cols[3]));
        }
        return map;
    }
}
