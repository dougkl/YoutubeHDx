using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using YoutubeHDx.Core.Subtitles;

namespace YoutubeHDx.Core.Library;

/// <summary>What the duplicate check knows about one video file.</summary>
public sealed record FileFacts(string Path, long Size, long ModifiedTicks, double Duration, int Width, int Height, long BitRate,
    string? Title, string? Artist)
{
    [JsonIgnore] public string Quality => (Height > 0 ? $"{Height}p" : "?p") + (BitRate > 0 ? $" {BitRate / 1_000_000.0:0.#} Mb/s" : "");
    [JsonIgnore] public string Length => Duration > 0 ? TimeSpan.FromSeconds(Math.Round(Duration)).ToString(Duration >= 3600 ? @"h\:mm\:ss" : @"m\:ss", CultureInfo.InvariantCulture) : "?";
    [JsonIgnore] public string SizeText => Size >= 1 << 30 ? $"{Size / (double)(1 << 30):0.0} GB" : $"{Size / (double)(1 << 20):0} MB";
}

/// <summary>A copy hidden from Plex because a better copy of the same song exists.</summary>
/// <param name="State">ignored = hidden from Plex; shown = you un-ignored it; unsafe = can't be hidden without hiding another file.</param>
public sealed record DuplicateEntry(string Path, string KeptPath, FileFacts Facts, FileFacts KeptFacts, string Reason, string State);

/// <summary>Two files that might be the same song: you decide.</summary>
public sealed record CheckPair(string PathA, string PathB, FileFacts A, FileFacts B, string Reason)
{
    [JsonIgnore] public string Key => DuplicateFinder.PairKey(PathA, PathB);
}

public sealed record DuplicateResults(DateTimeOffset? ScannedAt, int FilesChecked, IReadOnlyList<string> Folders,
    IReadOnlyList<DuplicateEntry> Duplicates, IReadOnlyList<CheckPair> Check)
{
    public static readonly DuplicateResults Empty = new(null, 0, [], [], []);
}

/// <summary>
/// Finds the same song saved more than once (old downloads, other folders, new 4K downloads) and hides all but the
/// best copy from Plex with .plexignore. Nothing is deleted or moved unless you ask for it in the Duplicates tab.
/// Clear-cut duplicates only (same artist, song, version and length); anything less certain goes to "Check these".
/// </summary>
public sealed partial class DuplicateFinder
{
    public const string ActivityKey = "3-duplicates";
    public const string ActivityName = "Duplicate check";
    private static readonly string[] VideoExtensions = [".mkv", ".mp4", ".webm", ".avi", ".m4v", ".mov", ".wmv", ".flv", ".mpg", ".mpeg", ".ts"];

    private readonly Func<AppSettings> _settings;
    private readonly IMediaProbe _probe;
    private readonly Action<string> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private State _state;

    public DuplicateFinder(Func<AppSettings> settings, IMediaProbe probe, Action<string> log)
    {
        _settings = settings;
        _probe = probe;
        _log = log;
        _state = State.Load();
    }

    public ActivityBoard? Board { get; set; }

    /// <summary>Raised after every change to the results (scan, un-ignore, move...).</summary>
    public event Action<DuplicateResults>? Changed;

    public DuplicateResults Results => _state.Last ?? DuplicateResults.Empty;

    [GeneratedRegex(@"\s*\[[\w-]{11}\]$")]
    private static partial Regex IdSuffix();

    public static string PairKey(string a, string b) =>
        string.Compare(a, b, StringComparison.OrdinalIgnoreCase) <= 0 ? $"{a}|{b}" : $"{b}|{a}";

    /// <summary>The folders checked: settings.duplicateFolders (relative ones are relative to the download folder), else the download folder.</summary>
    public static IReadOnlyList<string> FoldersToCheck(AppSettings s)
    {
        var list = s.DuplicateFolders.Count == 0 ? [s.NasPath] : s.DuplicateFolders;
        return list.Where(f => !string.IsNullOrWhiteSpace(f))
            .Select(f => Path.GetFullPath(Path.IsPathRooted(f) ? f : Path.Combine(s.NasPath, f)))
            .Select(f => f.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    // ---------------------------------------------------------------- scanning

    /// <param name="preview">Work everything out but change no .plexignore and save nothing (to look before hiding).</param>
    public async Task<DuplicateResults> ScanAsync(CancellationToken ct, bool preview = false)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var s = _settings();
            var roots = FoldersToCheck(s).Where(Directory.Exists).ToList();
            if (roots.Count == 0) throw new InvalidOperationException("None of the folders to check is reachable.");
            var skip = new HashSet<string>(s.DuplicateSkipFolders, StringComparer.OrdinalIgnoreCase);

            // Nested roots ("Music (videos)" and its "AutoDownload") would list files twice.
            roots = roots.Where(r => !roots.Any(o => o != r && IsUnder(r, o))).ToList();
            var files = roots.SelectMany(r => Enumerate(r, skip)).Distinct(StringComparer.OrdinalIgnoreCase)
                             .OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList();

            Board?.Start(ActivityKey, ActivityName, files.Count);
            var facts = await GatherFactsAsync(files, ct).ConfigureAwait(false);

            Board?.Progress(ActivityKey, files.Count - 1, "Comparing songs");
            var (dups, check) = Compare(facts, s.NasPath);
            var results = new DuplicateResults(DateTimeOffset.Now, facts.Count, roots, dups, check);
            _state.Last = results;
            results = ApplyIgnores(roots, files, write: !preview);
            if (!preview) _state.Save();

            var hidden = results.Duplicates.Count(d => d.State == "ignored");
            var summary = $"{facts.Count} videos: {hidden} duplicate copies hidden from Plex, {results.Check.Count} to check";
            _log($"Duplicate check: {summary}");
            Board?.Finish(ActivityKey, ActivityName, $"Last check {DateTimeOffset.Now:MMM d HH:mm}: {summary}");
            Changed?.Invoke(results);
            return results;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Board?.Finish(ActivityKey, ActivityName, $"Check failed {DateTimeOffset.Now:MMM d HH:mm}: {ex.Message}");
            throw;
        }
        finally
        {
            if (Board?.Get(ActivityKey) is { Running: true }) Board.Finish(ActivityKey, ActivityName, "Stopped");
            _gate.Release();
        }
    }

    private static bool IsUnder(string path, string root) =>
        path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> Enumerate(string root, HashSet<string> skip)
    {
        var stack = new Stack<string>([root]);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            string[] subdirs, here;
            try
            {
                subdirs = Directory.GetDirectories(dir);
                here = Directory.GetFiles(dir);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
            foreach (var d in subdirs)
            {
                var name = Path.GetFileName(d);
                if (!skip.Contains(name) && !name.StartsWith('.')) stack.Push(d);
            }
            foreach (var f in here)
                if (VideoExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase)) yield return f;
        }
    }

    private async Task<List<FileFacts>> GatherFactsAsync(List<string> files, CancellationToken ct)
    {
        var result = new FileFacts?[files.Count];
        var done = 0;
        await Parallel.ForEachAsync(Enumerable.Range(0, files.Count), new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
            async (i, token) =>
            {
                var path = files[i];
                FileInfo info;
                try { info = new FileInfo(path); if (!info.Exists) return; }
                catch (IOException) { return; }

                FileFacts? cached;
                lock (_state) cached = _state.Facts.GetValueOrDefault(path);
                if (cached is null || cached.Size != info.Length || cached.ModifiedTicks != info.LastWriteTimeUtc.Ticks)
                {
                    var m = await _probe.ProbeAsync(path, token).ConfigureAwait(false);
                    cached = new FileFacts(path, info.Length, info.LastWriteTimeUtc.Ticks, m?.Duration ?? 0, m?.Width ?? 0, m?.Height ?? 0,
                        m?.BitRate ?? 0, m?.Title, m?.Artist);
                    lock (_state) _state.Facts[path] = cached;
                }
                result[i] = cached;
                var n = Interlocked.Increment(ref done);
                if (n % 10 == 0) Board?.Progress(ActivityKey, n, Path.GetFileNameWithoutExtension(path));
            }).ConfigureAwait(false);

        lock (_state)
        {
            // Forget files that are gone.
            var present = new HashSet<string>(files, StringComparer.OrdinalIgnoreCase);
            foreach (var gone in _state.Facts.Keys.Where(k => !present.Contains(k)).ToList()) _state.Facts.Remove(gone);
        }
        return result.Where(f => f is not null).Select(f => f!).ToList();
    }

    // ---------------------------------------------------------------- matching

    private (List<DuplicateEntry>, List<CheckPair>) Compare(List<FileFacts> facts, string nasPath)
    {
        var ids = facts.Select(f => SongKey.Parse(IdSuffix().Replace(Path.GetFileNameWithoutExtension(f.Path), ""), f.Artist)).ToArray();

        // Sorted by length, so only files of similar length need comparing (unknown lengths compare with all).
        var order = Enumerable.Range(0, facts.Count).OrderBy(i => facts[i].Duration).ToArray();
        var parent = Enumerable.Range(0, facts.Count).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }

        var sameReason = new Dictionary<int, string>();
        var unsure = new List<(int A, int B, string Reason)>();
        void Consider(int a, int b)
        {
            var decision = _state.Decisions.GetValueOrDefault(PairKey(facts[a].Path, facts[b].Path));
            if (decision == "different") return;
            var r = SongKey.Compare(ids[a], facts[a].Duration, ids[b], facts[b].Duration);
            if (decision == "same" && r.Match != SongMatch.Same) r = new MatchResult(SongMatch.Same, "you said they're the same song");
            if (r.Match == SongMatch.Same)
            {
                parent[Find(a)] = Find(b);
                sameReason.TryAdd(a, r.Reason);
                sameReason.TryAdd(b, r.Reason);
            }
            else if (r.Match == SongMatch.Unsure) unsure.Add((a, b, r.Reason));
        }

        for (var x = 0; x < order.Length; x++)
        {
            var a = order[x];
            for (var y = x + 1; y < order.Length; y++)
            {
                var b = order[y];
                if (facts[a].Duration > 0 && facts[b].Duration - facts[a].Duration > SongKey.UnsureSeconds) break;
                Consider(a, b);
            }
        }

        var dups = new List<DuplicateEntry>();
        var hidden = new HashSet<int>();
        foreach (var group in Enumerable.Range(0, facts.Count).GroupBy(Find).Where(g => g.Count() > 1))
        {
            var ranked = group.OrderByDescending(i => facts[i].Height)
                .ThenByDescending(i => facts[i].BitRate)
                .ThenByDescending(i => facts[i].Size)
                .ThenByDescending(i => IsUnder(facts[i].Path, nasPath) ? 1 : 0)   // YoutubeHDx copy: has subtitles, .nfo, picture
                .ThenByDescending(i => facts[i].ModifiedTicks)
                .ToList();
            var best = ranked[0];
            foreach (var i in ranked.Skip(1))
            {
                hidden.Add(i);
                var why = $"{sameReason.GetValueOrDefault(i, "same song")}; kept copy: {facts[best].Quality}, {facts[best].SizeText}";
                var state = _state.NeverIgnore.Contains(facts[i].Path) ? "shown" : "ignored";
                dups.Add(new DuplicateEntry(facts[i].Path, facts[best].Path, facts[i], facts[best], why, state));
            }
        }

        var check = unsure
            .Where(u => !hidden.Contains(u.A) && !hidden.Contains(u.B) && Find(u.A) != Find(u.B))
            .Select(u => new CheckPair(facts[u.A].Path, facts[u.B].Path, facts[u.A], facts[u.B], u.Reason))
            .OrderBy(p => Path.GetFileName(p.PathA), StringComparer.OrdinalIgnoreCase)
            .ToList();
        return (dups.OrderBy(d => Path.GetFileName(d.Path), StringComparer.OrdinalIgnoreCase).ToList(), check);
    }

    // ---------------------------------------------------------------- .plexignore

    /// <summary>
    /// Writes our block into each folder's .plexignore. A pattern is only used if it hides nothing but duplicates;
    /// otherwise the entry is marked "unsafe" (move it instead). Patterns in a checked root folder apply to its whole
    /// tree in Plex, so they're checked against every file under it.
    /// </summary>
    private DuplicateResults ApplyIgnores(IReadOnlyList<string> roots, IReadOnlyList<string>? allFiles = null, bool write = true)
    {
        var last = _state.Last ?? DuplicateResults.Empty;
        allFiles ??= _state.Facts.Keys.ToList();
        var toHide = new HashSet<string>(last.Duplicates.Where(d => d.State != "shown").Select(d => d.Path), StringComparer.OrdinalIgnoreCase);
        // Visible files by folder, to check each pattern against its neighbours only.
        var visibleByDir = allFiles.Where(f => !toHide.Contains(f))
            .GroupBy(f => Path.GetDirectoryName(f)!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Select(Path.GetFileName).ToList(), StringComparer.OrdinalIgnoreCase);

        var updated = new List<DuplicateEntry>();
        var patternsByDir = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var d in last.Duplicates)
        {
            if (d.State == "shown") { updated.Add(d); continue; }
            var dir = Path.GetDirectoryName(d.Path)!;
            var pattern = PlexIgnore.PatternFor(Path.GetFileName(d.Path));
            var isRoot = roots.Contains(dir, StringComparer.OrdinalIgnoreCase);
            var literal = pattern.Split('*')[0];
            var clash = visibleByDir
                .Where(kv => string.Equals(kv.Key, dir, StringComparison.OrdinalIgnoreCase) || (isRoot && IsUnder(kv.Key, dir)))
                .SelectMany(kv => kv.Value)
                .Any(name => name!.StartsWith(literal, StringComparison.OrdinalIgnoreCase) && PlexIgnore.Matches(pattern, name));
            if (clash) { updated.Add(d with { State = "unsafe" }); continue; }
            updated.Add(d with { State = "ignored" });
            if (!patternsByDir.TryGetValue(dir, out var list)) patternsByDir[dir] = list = new();
            if (!list.Contains(pattern, StringComparer.OrdinalIgnoreCase)) list.Add(pattern);
        }

        foreach (var dir in !write ? [] : patternsByDir.Keys.Concat(_state.ManagedDirs).Distinct(StringComparer.OrdinalIgnoreCase).ToList())
        {
            var patterns = patternsByDir.GetValueOrDefault(dir) ?? new List<string>();
            try
            {
                if (!Directory.Exists(dir)) { _state.ManagedDirs.Remove(dir); continue; }
                if (PlexIgnore.WriteManaged(dir, patterns)) _log($"Updated .plexignore in {dir} ({patterns.Count} duplicate(s) hidden)");
                if (patterns.Count > 0) _state.ManagedDirs.Add(dir); else _state.ManagedDirs.Remove(dir);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _log($"Could not update .plexignore in {dir}: {e.Message}");
            }
        }

        _state.Last = last with { Duplicates = updated };
        return _state.Last;
    }

    // ---------------------------------------------------------------- your decisions

    /// <summary>Shows these files in Plex again, and never hides them again.</summary>
    public Task<DuplicateResults> UnignoreAsync(IEnumerable<string> paths) => ChangeAsync(() =>
    {
        foreach (var p in paths) _state.NeverIgnore.Add(p);
        Restate(p => _state.NeverIgnore.Contains(p) ? "shown" : null);
    });

    /// <summary>Hides files you un-ignored earlier again.</summary>
    public Task<DuplicateResults> IgnoreAgainAsync(IEnumerable<string> paths) => ChangeAsync(() =>
    {
        var set = paths.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var p in set) _state.NeverIgnore.Remove(p);
        Restate(p => set.Contains(p) ? "ignored" : null);
    });

    private void Restate(Func<string, string?> newState)
    {
        var last = _state.Last ?? DuplicateResults.Empty;
        _state.Last = last with { Duplicates = last.Duplicates.Select(d => newState(d.Path) is { } st ? d with { State = st } : d).ToList() };
    }

    /// <summary>Records your answer for a "check these" pair; a full re-check follows so groups are rebuilt.</summary>
    public async Task<DuplicateResults> DecideAsync(string pathA, string pathB, bool sameSong, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _state.Decisions[PairKey(pathA, pathB)] = sameSong ? "same" : "different";
            if (!sameSong && _state.Last is { } last)
                _state.Last = last with { Check = last.Check.Where(c => c.Key != PairKey(pathA, pathB)).ToList() };
            _state.Save();
        }
        finally
        {
            _gate.Release();
        }
        if (!sameSong) { Changed?.Invoke(Results); return Results; }
        return await ScanAsync(ct).ConfigureAwait(false);
    }

    public sealed record MoveResult(int Moved, IReadOnlyList<string> Problems);

    /// <summary>Moves the videos (with their .srt/.nfo/.jpg) to another folder. Never overwrites.</summary>
    public async Task<MoveResult> MoveAsync(IReadOnlyCollection<string> paths, string targetDir, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        var moved = 0;
        var problems = new List<string>();
        try
        {
            Directory.CreateDirectory(targetDir);
            var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var video in paths)
            {
                ct.ThrowIfCancellationRequested();
                var dir = Path.GetDirectoryName(video)!;
                var stem = Path.GetFileNameWithoutExtension(video);
                var group = Directory.EnumerateFiles(dir).Where(f =>
                    string.Equals(f, video, StringComparison.OrdinalIgnoreCase) ||
                    Path.GetFileName(f).StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase) &&
                    !VideoExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase)).ToList();
                var clash = group.FirstOrDefault(f => File.Exists(Path.Combine(targetDir, Path.GetFileName(f))));
                if (clash is not null) { problems.Add($"{Path.GetFileName(clash)}: a file with that name is already there"); continue; }
                try
                {
                    foreach (var f in group) File.Move(f, Path.Combine(targetDir, Path.GetFileName(f)), overwrite: false);
                    moved++;
                    done.Add(video);
                    _log($"Moved duplicate {video} -> {targetDir}");
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    problems.Add($"{Path.GetFileName(video)}: {e.Message}");
                }
            }

            if (_state.Last is { } last)
            {
                _state.Last = last with { Duplicates = last.Duplicates.Where(d => !done.Contains(d.Path)).ToList() };
                foreach (var p in done) _state.Facts.Remove(p);
                ApplyIgnores(last.Folders);
            }
            _state.Save();
        }
        finally
        {
            _gate.Release();
        }
        Changed?.Invoke(Results);
        return new MoveResult(moved, problems);
    }

    private async Task<DuplicateResults> ChangeAsync(Action change)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            change();
            ApplyIgnores((_state.Last ?? DuplicateResults.Empty).Folders);
            _state.Save();
        }
        finally
        {
            _gate.Release();
        }
        Changed?.Invoke(Results);
        return Results;
    }

    // ---------------------------------------------------------------- saved state

    private sealed class State
    {
        public Dictionary<string, FileFacts> Facts { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> NeverIgnore { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Decisions { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> ManagedDirs { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public DuplicateResults? Last { get; set; }

        public static State Load()
        {
            try
            {
                if (File.Exists(AppPaths.DuplicateStateFile) &&
                    JsonSerializer.Deserialize<State>(File.ReadAllText(AppPaths.DuplicateStateFile), Json.Options) is { } s)
                {
                    // JSON drops the case-insensitive comparers; Windows paths need them.
                    return new State
                    {
                        Facts = new(s.Facts, StringComparer.OrdinalIgnoreCase),
                        NeverIgnore = new(s.NeverIgnore, StringComparer.OrdinalIgnoreCase),
                        Decisions = new(s.Decisions, StringComparer.OrdinalIgnoreCase),
                        ManagedDirs = new(s.ManagedDirs, StringComparer.OrdinalIgnoreCase),
                        Last = s.Last,
                    };
                }
            }
            catch (Exception e) when (e is IOException or JsonException) { /* start over */ }
            return new State();
        }

        public void Save()
        {
            try
            {
                AppPaths.EnsureDataDir();
                var tmp = AppPaths.DuplicateStateFile + ".tmp";
                lock (this) File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json.Options));
                File.Move(tmp, AppPaths.DuplicateStateFile, overwrite: true);
            }
            catch (IOException) { /* best effort: the next scan rebuilds it */ }
        }
    }
}
