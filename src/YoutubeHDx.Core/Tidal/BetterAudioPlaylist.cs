using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using YoutubeHDx.Core.Library;
using YoutubeHDx.Core.Lyrics;

namespace YoutubeHDx.Core.Tidal;

/// <summary>Result of looking up one video on TIDAL.</summary>
public sealed record TidalMatch(string Path, string Status, double VideoSeconds, string? TrackId = null, string? TidalArtist = null,
    string? TidalTitle = null, double TidalSeconds = 0, string? Quality = null, bool Added = false, DateTimeOffset? CheckedAt = null,
    long Size = 0, long ModifiedTicks = 0)
{
    public double Diff => TidalSeconds > 0 ? Math.Abs(TidalSeconds - VideoSeconds) : 0;
}

public sealed record PlaylistSummary(int Checked, int Matched, int Added, int LengthDiffers, int NotFound, string? PlaylistId, int Removed = 0)
{
    public string Describe() =>
        $"{Matched} songs match ({Added} added" + (Removed > 0 ? $", {Removed} taken out" : "") +
        $"), {LengthDiffers} found but with a different length, {NotFound} not found on TIDAL";
}

/// <summary>
/// Keeps a TIDAL playlist of the songs in your music-video library whose TIDAL track is the same recording at the same
/// length as the video (within <see cref="ToleranceSeconds"/>), i.e. the ones whose audio could be swapped for better
/// audio without any editing. Same "same song" rules as the duplicate check: a live, remix, long version... never
/// matches the plain song. Writes better-audio-tidal.csv next to your downloads with every result.
/// </summary>
public sealed partial class BetterAudioPlaylist
{
    public const double ToleranceSeconds = 2;
    public const string PlaylistName = "YoutubeHDx – better audio";
    public const string CsvName = "better-audio-tidal.csv";
    public const string ActivityKey = "4-tidal";
    public const string ActivityName = "TIDAL better-audio playlist";
    private static readonly TimeSpan Recheck = TimeSpan.FromDays(30);

    /// <summary>Bumped when the matching rules get stricter: earlier matches are then looked up again.</summary>
    public const int RulesVersion = 2;

    private readonly Func<AppSettings> _settings;
    private readonly TidalApi _api;
    private readonly Action<string> _log;

    public ActivityBoard? Board { get; set; }

    public BetterAudioPlaylist(Func<AppSettings> settings, TidalApi api, Action<string> log)
    {
        _settings = settings;
        _api = api;
        _log = log;
    }

    public static string StateFile => Path.Combine(AppPaths.DataDir, "tidal-playlist.json");

    [GeneratedRegex(@"\s*\[[\w-]{11}\]$")]
    private static partial Regex IdSuffix();

    private sealed class State
    {
        public string? PlaylistId { get; set; }
        public int RulesVersion { get; set; }

        /// <summary>Tracks this app put in the playlist (only those are ever taken out again).</summary>
        public HashSet<string> OurTracks { get; set; } = new();

        /// <summary>Tracks you removed from the playlist yourself: never added again.</summary>
        public HashSet<string> RemovedByYou { get; set; } = new();
        public Dictionary<string, TidalMatch> Results { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    public async Task<PlaylistSummary> RunAsync(IReadOnlyList<FileFacts> videos, CancellationToken ct)
    {
        var state = Load();
        Board?.Start(ActivityKey, ActivityName, videos.Count);
        try
        {
            var fresh = false;
            string? existing = null;
            if (state.PlaylistId is null)
            {
                try { existing = await _api.FindOwnPlaylistAsync(PlaylistName, ct).ConfigureAwait(false); }
                catch (TidalApiException e) { _log($"TIDAL: couldn't list your playlists ({e.Message}); a new one will be made"); }
            }
            if (existing is not null)
            {
                state.PlaylistId = existing; // made on another PC (or before a reinstall): keep using it
                _log($"TIDAL: using your existing playlist {existing}");
            }
            if (state.PlaylistId is null || !await _api.PlaylistExistsAsync(state.PlaylistId, ct).ConfigureAwait(false))
            {
                state.PlaylistId = await _api.CreatePlaylistAsync(PlaylistName,
                    "Songs from my music-video library whose TIDAL track has the same length as the video (within 2 s). Kept up to date by YoutubeHDx.",
                    ct).ConfigureAwait(false);
                state.OurTracks.Clear();
                state.RemovedByYou.Clear();
                fresh = true;
                _log($"TIDAL: created playlist {state.PlaylistId}");
            }
            var adoptPresent = !fresh && state.RulesVersion == 0 && state.OurTracks.Count == 0; // made by version 1.8.0-pre: all ours
            if (state.RulesVersion < RulesVersion)
            {
                // Stricter rules: look up every earlier match again (only matches can change).
                foreach (var k in state.Results.Keys.ToList())
                    if (state.Results[k].Status == "match") state.Results[k] = state.Results[k] with { Status = "recheck", CheckedAt = DateTimeOffset.MinValue };
                state.RulesVersion = RulesVersion;
            }

            var done = 0;
            foreach (var v in videos)
            {
                ct.ThrowIfCancellationRequested();
                Board?.Progress(ActivityKey, done++, Path.GetFileNameWithoutExtension(v.Path));
                if (state.Results.TryGetValue(v.Path, out var old) && old.Size == v.Size && old.ModifiedTicks == v.ModifiedTicks &&
                    (old.Status == "match" || old.CheckedAt > DateTimeOffset.Now - Recheck))
                    continue;
                try
                {
                    state.Results[v.Path] = await LookUpAsync(v, ct).ConfigureAwait(false);
                }
                catch (TidalApiException e)
                {
                    _log($"TIDAL lookup failed for {Path.GetFileName(v.Path)}: {e.Message}");
                    state.Results[v.Path] = new TidalMatch(v.Path, "error", v.Duration, CheckedAt: DateTimeOffset.MinValue);
                }
                if (done % 25 == 0) Save(state);
            }

            // Forget files that are no longer in the library.
            var present = videos.Select(v => v.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var gone in state.Results.Keys.Where(k => !present.Contains(k)).ToList()) state.Results.Remove(gone);

            // Make the playlist match: add what's missing, take out what we added that no longer matches.
            Board?.Progress(ActivityKey, videos.Count - 1, "Updating the playlist");
            var wanted = state.Results.Values.Where(r => r is { Status: "match", TrackId: not null }).Select(r => r.TrackId!).ToHashSet();
            var inPlaylist = fresh ? new List<TidalApi.PlaylistItem>() : (await _api.GetPlaylistItemsAsync(state.PlaylistId!, ct).ConfigureAwait(false)).ToList();
            var presentIds = inPlaylist.Select(p => p.TrackId).ToHashSet();
            if (adoptPresent) state.OurTracks.UnionWith(presentIds);
            foreach (var gone in state.OurTracks.Where(id => !presentIds.Contains(id) && wanted.Contains(id)).ToList())
            {
                state.RemovedByYou.Add(gone); // we put it there and it's gone: you took it out
                state.OurTracks.Remove(gone);
            }
            var toAdd = wanted.Where(id => !presentIds.Contains(id) && !state.RemovedByYou.Contains(id)).ToList();
            var toRemove = inPlaylist.Where(p => state.OurTracks.Contains(p.TrackId) && !wanted.Contains(p.TrackId)).ToList();
            if (toAdd.Count > 0) await _api.AddTracksAsync(state.PlaylistId!, toAdd, ct).ConfigureAwait(false);
            if (toRemove.Count > 0) await _api.RemoveItemsAsync(state.PlaylistId!, toRemove, ct).ConfigureAwait(false);
            state.OurTracks.UnionWith(toAdd);
            state.OurTracks.ExceptWith(toRemove.Select(r => r.TrackId));
            foreach (var k in state.Results.Keys.ToList())
                if (state.Results[k] is { Status: "match", TrackId: { } id }) state.Results[k] = state.Results[k] with { Added = state.OurTracks.Contains(id) || presentIds.Contains(id) };
            Save(state);
            WriteCsv(state);

            var all = state.Results.Values.ToList();
            var summary = new PlaylistSummary(videos.Count, all.Count(r => r.Status == "match"), toAdd.Count,
                all.Count(r => r.Status == "length"), all.Count(r => r.Status is "notfound" or "noartist"), state.PlaylistId, toRemove.Count);
            Board?.Finish(ActivityKey, ActivityName, $"Last update {DateTimeOffset.Now:MMM d HH:mm}: {summary.Describe()}");
            _log($"TIDAL playlist: {summary.Describe()}");
            return summary;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Save(state);
            Board?.Finish(ActivityKey, ActivityName, $"Failed {DateTimeOffset.Now:MMM d HH:mm}: {e.Message}");
            throw;
        }
        finally
        {
            if (Board?.Get(ActivityKey) is { Running: true }) Board.Finish(ActivityKey, ActivityName, "Stopped");
        }
    }

    /// <summary>Searches TIDAL for one video and decides.</summary>
    public async Task<TidalMatch> LookUpAsync(FileFacts v, CancellationToken ct)
    {
        var title = IdSuffix().Replace(Path.GetFileNameWithoutExtension(v.Path), "");
        var video = SongKey.Parse(title, v.Artist);
        var stamp = (TidalMatch m) => m with { CheckedAt = DateTimeOffset.Now, Size = v.Size, ModifiedTicks = v.ModifiedTicks };
        if (video.Artist.Length == 0) return stamp(new TidalMatch(v.Path, "noartist", v.Duration));

        var guess = SongTitle.Guess(title, v.Artist).FirstOrDefault();
        var queries = new List<string>();
        if (guess is not null) queries.Add($"{guess.Artist} {SongTitle.WithoutFeat(guess.Track)}");
        queries.Add($"{video.Artist} {video.Track}");

        TidalTrack? closest = null;
        foreach (var q in queries.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var tracks = await _api.SearchTracksAsync(q, 10, ct).ConfigureAwait(false);
            var (best, near) = Pick(video, v.Duration, tracks);
            if (best is not null)
                return stamp(new TidalMatch(v.Path, "match", v.Duration, best.Id, string.Join(", ", best.Artists), best.FullTitle, best.Seconds, best.Quality));
            if (near is not null && (closest is null || Math.Abs(near.Seconds - v.Duration) < Math.Abs(closest.Seconds - v.Duration))) closest = near;
        }
        return stamp(closest is null
            ? new TidalMatch(v.Path, "notfound", v.Duration)
            : new TidalMatch(v.Path, "length", v.Duration, closest.Id, string.Join(", ", closest.Artists), closest.FullTitle, closest.Seconds, closest.Quality));
    }

    /// <summary>The same song at the same length (best), else the same song at another length (near).</summary>
    public static (TidalTrack? Best, TidalTrack? Near) Pick(SongId video, double videoSeconds, IReadOnlyList<TidalTrack> tracks)
    {
        TidalTrack? best = null, near = null;
        foreach (var t in tracks)
        {
            if (!SameSong(video, t)) continue;
            var diff = Math.Abs(t.Seconds - videoSeconds);
            if (videoSeconds > 0 && t.Seconds > 0 && diff <= ToleranceSeconds)
            {
                if (best is null || diff < Math.Abs(best.Seconds - videoSeconds) - 0.5 ||
                    (Math.Abs(diff - Math.Abs(best.Seconds - videoSeconds)) <= 0.5 && Rank(t) > Rank(best)))
                    best = t;
            }
            else if (near is null || diff < Math.Abs(near.Seconds - videoSeconds)) near = t;
        }
        return (best, near);
    }

    private static int Rank(TidalTrack t) => t.MediaTags.Contains("HIRES_LOSSLESS") ? 2 : t.MediaTags.Contains("LOSSLESS") ? 1 : 0;

    /// <summary>Same artist (any of the track's artists, or all of them together) and same song and version.</summary>
    public static bool SameSong(SongId video, TidalTrack t)
    {
        var names = t.Artists.Concat(t.Artists.Count > 1 ? [string.Join(" & ", t.Artists), string.Join(", ", t.Artists)] : []).Distinct();
        foreach (var artist in names)
        {
            var song = SongKey.Parse($"{artist} - {t.FullTitle}") with { Kind = video.Kind };
            if (SongKey.Compare(video, 200, song, 200).Match == SongMatch.Same) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- state and report

    private static State Load()
    {
        try
        {
            if (File.Exists(StateFile) && JsonSerializer.Deserialize<State>(File.ReadAllText(StateFile), Json.Options) is { } s)
                return new State
                {
                    PlaylistId = s.PlaylistId, RulesVersion = s.RulesVersion, OurTracks = s.OurTracks, RemovedByYou = s.RemovedByYou,
                    Results = new(s.Results, StringComparer.OrdinalIgnoreCase),
                };
        }
        catch (Exception e) when (e is IOException or JsonException) { }
        return new State();
    }

    private static void Save(State s)
    {
        AppPaths.EnsureDataDir();
        var tmp = StateFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(s, Json.Options));
        File.Move(tmp, StateFile, overwrite: true);
    }

    private void WriteCsv(State s)
    {
        static string Csv(string? v) => v is null ? "" : v.IndexOfAny([',', '"', '\n']) >= 0 ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;
        static string Sec(double x) => x > 0 ? x.ToString("0.0", CultureInfo.InvariantCulture) : "";
        var sb = new StringBuilder("result,file,video_seconds,tidal_seconds,difference,tidal_artist,tidal_title,tidal_quality,tidal_link\r\n");
        foreach (var r in s.Results.Values.OrderBy(r => r.Status switch { "match" => 0, "length" => 1, _ => 2 }).ThenBy(r => Path.GetFileName(r.Path)))
        {
            var result = r.Status switch
            {
                "match" => "in playlist (same length)",
                "length" => "on TIDAL, different length",
                "noartist" => "no artist in file name",
                "error" => "lookup failed",
                _ => "not found on TIDAL",
            };
            sb.Append(Csv(result)).Append(',').Append(Csv(r.Path)).Append(',').Append(Sec(r.VideoSeconds)).Append(',').Append(Sec(r.TidalSeconds))
              .Append(',').Append(r.TidalSeconds > 0 ? (r.TidalSeconds - r.VideoSeconds).ToString("+0.0;-0.0;0", CultureInfo.InvariantCulture) : "")
              .Append(',').Append(Csv(r.TidalArtist)).Append(',').Append(Csv(r.TidalTitle)).Append(',').Append(Csv(r.Quality))
              .Append(',').Append(r.TrackId is null ? "" : $"https://tidal.com/browse/track/{r.TrackId}").Append("\r\n");
        }
        var path = Path.Combine(_settings().NasPath, CsvName);
        try
        {
            using var fs = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
            fs.SetLength(0);
            fs.Write(new UTF8Encoding(true).GetPreamble());
            fs.Write(Encoding.UTF8.GetBytes(sb.ToString()));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { _log($"Could not write {path}: {e.Message}"); }
    }
}
