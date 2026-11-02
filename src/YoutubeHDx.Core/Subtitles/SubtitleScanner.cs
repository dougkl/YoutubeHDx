using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using YoutubeHDx.Core.Lyrics;

namespace YoutubeHDx.Core.Subtitles;

public sealed record ScanSummary(int Checked, int AlreadyGood, int Fixed, int NotFound, int Skipped, bool Stopped)
{
    public string Describe() =>
        $"{Checked} checked: {Fixed} fixed, {AlreadyGood} already fine, {NotFound} with no lyrics found yet" +
        (Stopped ? " (stopped early: downloads are paused)" : "");
}

/// <summary>What happened to one file.</summary>
public enum ScanOutcome { Unchanged, Good, Fixed, NotFound, NotOurs, Unreadable, Paused }

/// <summary>
/// Goes through downloaded videos and adds a proper English subtitle where there is none or it is bad.
/// Only ever creates new sidecar files ("Title [id].en.srt", then "...en.lyrics.srt", ...): never edits or deletes,
/// so it works on a NAS share that only allows creating files. Results per file are remembered locally, so a
/// daily scan only looks at new or changed files and at videos listed in the bad-subtitles list.
/// </summary>
public sealed partial class SubtitleScanner
{
    private static readonly string[] VideoExtensions = [".mkv", ".mp4", ".webm"];
    private static readonly TimeSpan RetryNotFound = TimeSpan.FromDays(7);
    private static readonly TimeSpan RetryUnreachable = TimeSpan.FromHours(1);

    private readonly Func<AppSettings> _settings;
    private readonly IMediaProbe _probe;
    private readonly Func<AppSettings, LyricsFinder> _finder;
    private readonly Func<bool> _isPaused;
    private readonly Action<string> _log;
    private readonly Func<DateTimeOffset> _now;
    private readonly TimeSpan _delayBetweenLookups;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public SubtitleScanner(Func<AppSettings> settings, IMediaProbe probe, Func<AppSettings, LyricsFinder> finder,
        Func<bool> isPaused, Action<string> log, Func<DateTimeOffset>? now = null, TimeSpan? delayBetweenLookups = null)
    {
        _settings = settings;
        _probe = probe;
        _finder = finder;
        _isPaused = isPaused;
        _log = log;
        _now = now ?? (() => DateTimeOffset.Now);
        _delayBetweenLookups = delayBetweenLookups ?? TimeSpan.FromSeconds(1); // be polite to LRCLIB
    }

    [GeneratedRegex(@"\[([\w-]{11})\]\.[^.\\/]+$")]
    private static partial Regex IdInFileName();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2} - ")]
    private static partial Regex DatePrefix();

    // ---------------------------------------------------------------- state

    private sealed class VideoState
    {
        public string Path { get; set; } = "";
        public long Size { get; set; }
        public long ModifiedTicks { get; set; }
        public string Status { get; set; } = "";              // good | fixed | notFound
        public DateTimeOffset? RetryAfter { get; set; }
        public List<string> AddedFiles { get; set; } = new();
        public List<string> AddedSources { get; set; } = new(); // lrclib:<id> / os:<file_id>
        public List<string> Rejected { get; set; } = new();
        public int FlagsHandled { get; set; }
        public string? Note { get; set; }
    }

    private static Dictionary<string, VideoState> LoadState()
    {
        try
        {
            if (File.Exists(AppPaths.SubtitleStateFile))
                return JsonSerializer.Deserialize<Dictionary<string, VideoState>>(File.ReadAllText(AppPaths.SubtitleStateFile), Json.Options)
                       ?? new();
        }
        catch (Exception e) when (e is IOException or JsonException) { /* start over */ }
        return new();
    }

    private static void SaveState(Dictionary<string, VideoState> state)
    {
        AppPaths.EnsureDataDir();
        var tmp = AppPaths.SubtitleStateFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json.Options));
        File.Move(tmp, AppPaths.SubtitleStateFile, overwrite: true);
    }

    // ---------------------------------------------------------------- scanning

    public async Task<ScanSummary> ScanAllAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var s = _settings();
            if (!Directory.Exists(s.NasPath)) throw new InvalidOperationException($"NAS folder '{s.NasPath}' is not reachable.");
            var flags = BadSubsList.Read(s.NasPath);
            var state = LoadState();
            int good = 0, fixedN = 0, notFound = 0, skipped = 0, checkedN = 0;
            var stopped = false;

            foreach (var file in Directory.EnumerateFiles(s.NasPath, "*", SearchOption.AllDirectories)
                         .Where(f => VideoExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                         .OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
            {
                var outcome = await ScanOneAsync(file, s, flags, state, ct).ConfigureAwait(false);
                switch (outcome)
                {
                    case ScanOutcome.Paused: stopped = true; break;
                    case ScanOutcome.Good: good++; checkedN++; break;
                    case ScanOutcome.Fixed: fixedN++; checkedN++; break;
                    case ScanOutcome.NotFound: notFound++; checkedN++; break;
                    default: skipped++; break;
                }
                if (stopped) break;
            }

            SaveState(state);
            var summary = new ScanSummary(checkedN, good, fixedN, notFound, skipped, stopped);
            _log($"Subtitle scan: {summary.Describe()}");
            return summary;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Checks one file (e.g. right after it was downloaded).</summary>
    public async Task<ScanOutcome> ScanFileAsync(string file, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var s = _settings();
            var state = LoadState();
            var outcome = await ScanOneAsync(file, s, BadSubsList.Read(s.NasPath), state, ct).ConfigureAwait(false);
            SaveState(state);
            return outcome;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<ScanOutcome> ScanOneAsync(string file, AppSettings s, Dictionary<string, int> flags,
        Dictionary<string, VideoState> state, CancellationToken ct)
    {
        var m = IdInFileName().Match(Path.GetFileName(file));
        if (!m.Success) return ScanOutcome.NotOurs;
        var id = m.Groups[1].Value;

        FileInfo info;
        try { info = new FileInfo(file); if (!info.Exists) return ScanOutcome.Unreadable; }
        catch (IOException) { return ScanOutcome.Unreadable; }

        var st = state.TryGetValue(id, out var existing) ? existing : null;
        var flagCount = flags.GetValueOrDefault(id);
        var newlyFlagged = flagCount > (st?.FlagsHandled ?? 0);
        var sameFile = st is not null && st.Size == info.Length && st.ModifiedTicks == info.LastWriteTimeUtc.Ticks &&
                       (st.Path == file || !File.Exists(st.Path)); // renamed (e.g. date removed): same video, no recheck
        if (sameFile && st!.Path != file) st.Path = file;

        if (sameFile && !newlyFlagged)
        {
            if (st!.Status is "good" or "fixed") return ScanOutcome.Unchanged;
            if (st.Status == "notFound" && st.RetryAfter > _now()) return ScanOutcome.Unchanged;
        }
        if (_isPaused()) return ScanOutcome.Paused;

        st ??= new VideoState();
        st.Path = file;
        st.Size = info.Length;
        st.ModifiedTicks = info.LastWriteTimeUtc.Ticks;
        state[id] = st;

        var media = await _probe.ProbeAsync(file, ct).ConfigureAwait(false);
        if (media is null)
        {
            _log($"Subtitle scan: can't read {Path.GetFileName(file)} (ffprobe failed)");
            st.Status = "notFound";
            st.RetryAfter = _now() + RetryUnreachable;
            return ScanOutcome.Unreadable;
        }

        if (newlyFlagged)
        {
            // You said the subtitles are wrong: whatever we added last is rejected, and we look again.
            if (st.AddedSources.Count > 0 && !st.Rejected.Contains(st.AddedSources[^1])) st.Rejected.Add(st.AddedSources[^1]);
            st.FlagsHandled = flagCount;
            _log($"Subtitle scan: {id} is on the bad-subtitles list; looking for others");
        }
        else
        {
            var problem = await CurrentSubtitleProblemAsync(file, media, ct).ConfigureAwait(false);
            if (problem is null)
            {
                st.Status = st.AddedFiles.Count > 0 ? "fixed" : "good";
                st.Note = null;
                return ScanOutcome.Good;
            }
            st.Note = problem;
        }

        // Look for lyrics whose timing matches the video, skipping anything already rejected.
        var title = media.Title ?? TitleFromFileName(file);
        var finder = _finder(s);
        var lookup = await finder.FindAsync(title, media.Artist, media.Duration, st.Rejected, ct).ConfigureAwait(false);
        if (_delayBetweenLookups > TimeSpan.Zero) await Task.Delay(_delayBetweenLookups, ct).ConfigureAwait(false);

        if (lookup.Result is not { } found)
        {
            st.Status = "notFound";
            st.RetryAfter = _now() + (lookup.Retryable ? RetryUnreachable : RetryNotFound);
            _log($"Subtitle scan: no lyrics for {Path.GetFileName(file)} ({lookup.Reason})");
            return ScanOutcome.NotFound;
        }

        var written = WriteSidecar(file, found.Cues);
        st.AddedFiles.Add(Path.GetFileName(written));
        st.AddedSources.Add(found.Id);
        st.Status = "fixed";
        st.RetryAfter = null;
        _log($"Subtitle scan: added {Path.GetFileName(written)} from {found.Source} ({found.Matched})");
        return ScanOutcome.Fixed;
    }

    /// <summary>Null if the video already has usable English subtitles; otherwise why not.</summary>
    private async Task<string?> CurrentSubtitleProblemAsync(string file, MediaInfo media, CancellationToken ct)
    {
        string? firstProblem = null;
        foreach (var sidecar in Sidecars(file))
        {
            var problem = SubtitleText.Problem(SubtitleText.ParseSrt(await File.ReadAllTextAsync(sidecar, ct).ConfigureAwait(false)), media.Duration);
            if (problem is null) return null;
            firstProblem ??= $"{Path.GetFileName(sidecar)}: {problem}";
        }

        // Embedded English subtitles (only read if there is no sidecar copy: reading them means reading the whole file).
        if (firstProblem is null)
        {
            foreach (var sub in media.Subtitles.Where(x => x.Language is null or "eng" or "en" || x.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase)))
            {
                var srt = await _probe.ExtractSubtitleAsync(file, sub.Index, ct).ConfigureAwait(false);
                var problem = SubtitleText.Problem(SubtitleText.ParseSrt(srt), media.Duration);
                if (problem is null) return null;
                firstProblem ??= $"embedded subtitles: {problem}";
            }
        }
        return firstProblem ?? "no subtitles";
    }

    /// <summary>"Title [id].en.srt", "Title [id].en-xxxx.srt", ... next to the video (English only).</summary>
    private static IEnumerable<string> Sidecars(string file)
    {
        var dir = Path.GetDirectoryName(file)!;
        var stem = Path.GetFileNameWithoutExtension(file);
        foreach (var f in Directory.EnumerateFiles(dir, "*.srt"))
        {
            var name = Path.GetFileName(f);
            if (!name.StartsWith(stem + ".", StringComparison.Ordinal)) continue;
            var lang = name[(stem.Length + 1)..];
            if (lang.StartsWith("en", StringComparison.OrdinalIgnoreCase)) yield return f;
        }
    }

    /// <summary>Writes a new sidecar, never replacing an existing file.</summary>
    private static string WriteSidecar(string videoFile, IReadOnlyList<Cue> cues)
    {
        var dir = Path.GetDirectoryName(videoFile)!;
        var stem = Path.GetFileNameWithoutExtension(videoFile);
        var bytes = new UTF8Encoding(false).GetBytes(SubtitleText.ToSrt(cues));
        for (var n = 0; n < 50; n++)
        {
            var suffix = n switch { 0 => ".en.srt", 1 => ".en.lyrics.srt", _ => $".en.lyrics{n}.srt" };
            var path = Path.Combine(dir, stem + suffix);
            try
            {
                using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
                fs.Write(bytes);
                return path;
            }
            catch (IOException) when (File.Exists(path))
            {
                // taken: try the next name
            }
        }
        throw new IOException($"No free subtitle file name next to {videoFile}");
    }

    /// <summary>"2009-03-05 - Divinyls - I Touch Myself (Official Music Video) [wv-34w8kGPM].mkv" -> the YouTube title.</summary>
    public static string TitleFromFileName(string file)
    {
        var name = IdInFileName().Replace(Path.GetFileName(file), "").Trim(); // drops "[id].mkv"
        return DatePrefix().Replace(name, "").Trim();                          // drops "2009-03-05 - "
    }
}
