using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using YoutubeHDx.Core.Lyrics;

namespace YoutubeHDx.Core.Library;

/// <summary>What a file name says about the song: who, which song, and which version of it.</summary>
public sealed record SongId(string Artist, string Track, string Kind, IReadOnlyDictionary<string, int> Markers, string Raw)
{
    public string MarkerText => Markers.Count == 0 ? "" : string.Join(", ", Markers.Keys.OrderBy(k => k, StringComparer.Ordinal));
}

public enum SongMatch { Different, Unsure, Same }

public sealed record MatchResult(SongMatch Match, string Reason);

/// <summary>
/// Decides whether two video files are the same recording. Errs on the side of "different": a live, acoustic,
/// remix, cover, demo, extended/long/stereo/alternate version... is never the same song as the plain one, and the
/// lengths must agree. Anything in between is "unsure" and left for you to decide.
/// </summary>
public static partial class SongKey
{
    /// <summary>Lengths this close (or 2%) are the same recording.</summary>
    public const double SameSeconds = 3;

    /// <summary>Same song, but lengths this far apart: probably a different cut. Beyond this: different.</summary>
    public const double UnsureSeconds = 25;

    // Words that make a different version of a song. Counted, so "Live Is Life" vs "Live Is Life (Live)" differ.
    [GeneratedRegex(@"\b(live|acoustic|unplugged|remix|rmx|mix|cover|demo|extended|long|edit|instrumental|karaoke|version|stereo|mono|concert|session|tour|totp|top of the pops|reprise|medley|mashup|parody|tribute|orchestral|symphonic|a ?cappella|rehearsal|bootleg|dub|reggae|slowed|sped up|nightcore|pt|part)\b")]
    private static partial Regex MarkerWords();

    // "official version", "video version": just the normal video.
    [GeneratedRegex(@"\b(official|video|music video|official video|hd|original) version\b")]
    private static partial Regex PlainVersion();

    [GeneratedRegex(@"\blyrics?\b|\bwith lyrics\b")]
    private static partial Regex LyricKind();

    [GeneratedRegex(@"\b(official )?audio\b|\bvisuali[sz]er\b|\bstatic\b")]
    private static partial Regex AudioKind();

    [GeneratedRegex(@"\s+[-–—~]\s*|\s*[-–—~]\s+|\s*~\s*|\s{3,}")]
    private static partial Regex Separator();

    [GeneratedRegex(@"\s*\b(feat\.?|ft\.?|featuring)\s.*$")]
    private static partial Regex Feat();

    [GeneratedRegex(@"[\(\[\{][^\)\]\}]*[\)\]\}]")]
    private static partial Regex Brackets();

    [GeneratedRegex(@"\b(19|20)\d{2}\b")]
    private static partial Regex Year();

    [GeneratedRegex(@"\b(official|officiel|video|videoclip|clip|music|audio|hd|hq|uhd|4k|8k|1080p|720p|480p|remastered|remaster|original|widescreen|lyrics?|mv|promo|film|vod|full|high quality)\b")]
    private static partial Regex Noise();

    public static SongId Parse(string title, string? artistHint = null)
    {
        var raw = title.Trim();
        var low = Fold(raw);

        var kind = LyricKind().IsMatch(low) ? "lyrics" : AudioKind().IsMatch(low) ? "audio" : "video";

        var markers = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (Match m in MarkerWords().Matches(PlainVersion().Replace(low, " ")))
        {
            var w = m.Value.Replace(" ", "");
            markers[w] = markers.GetValueOrDefault(w) + 1;
        }

        string artist, track;
        var parts = Separator().Split(raw, 2);
        if (parts.Length == 2 && Norm(parts[0]).Length > 0 && Norm(parts[1]).Length > 0)
        {
            artist = Norm(parts[0]);
            track = Norm(parts[1]);
        }
        else if (raw.Count(c => c == '-') == 1 && raw.IndexOf('-') is var i && i > 0 &&
                 raw[..i].Trim().Contains(' ') && Norm(raw[(i + 1)..]).Length > 0)
        {
            // "Pharrell Williams-Happy": one dash, artist has a space
            artist = Norm(raw[..i]);
            track = Norm(raw[(i + 1)..]);
        }
        else
        {
            artist = string.IsNullOrWhiteSpace(artistHint) ? "" : Norm(SongTitle.CleanAuthor(artistHint));
            track = Norm(raw);
        }
        return new SongId(artist, track, kind, markers, raw);
    }

    public static MatchResult Compare(SongId a, double durationA, SongId b, double durationB)
    {
        if (a.Track.Length == 0 || b.Track.Length == 0) return new(SongMatch.Different, "no song name");
        if (!SameMarkers(a, b))
            return new(SongMatch.Different, $"different versions ({Describe(a)} / {Describe(b)})");

        var known = durationA > 0 && durationB > 0;
        var diff = known ? Math.Abs(durationA - durationB) : double.NaN;
        var sameLength = known && diff <= Math.Max(SameSeconds, 0.02 * Math.Max(durationA, durationB));
        var lengthText = known ? $"lengths differ by {diff:0}s" : "length unknown";

        var sameNames = a.Artist.Length > 0 && b.Artist.Length > 0 &&
                        ((a.Artist == b.Artist && a.Track == b.Track) || (a.Artist == b.Track && a.Track == b.Artist));
        if (sameNames)
        {
            if (a.Kind != b.Kind) return new(SongMatch.Unsure, $"same song, but one is a {(a.Kind == "video" ? b.Kind : a.Kind)} video");
            if (!known) return new(SongMatch.Unsure, "same song, length unknown");
            if (sameLength) return new(SongMatch.Same, "same artist, song and length");
            if (diff <= UnsureSeconds) return new(SongMatch.Unsure, $"same song, but {lengthText} (maybe another cut)");
            return new(SongMatch.Different, $"same name, but {lengthText}");
        }

        // The very same name and length ("What Is Life (2014 Remaster)" in two folders), whatever artist the tags suggest.
        if (sameLength && a.Kind == b.Kind && Norm(a.Raw) is { Length: >= 4 } na && na == Norm(b.Raw))
            return new(SongMatch.Same, "same name and length");

        // One file has no artist in its name ("barracuda.mkv").
        var oneNameless = (a.Artist.Length == 0) != (b.Artist.Length == 0);
        if (oneNameless && sameLength)
        {
            var named = a.Artist.Length > 0 ? a : b;
            var bare = a.Artist.Length > 0 ? b : a;
            if (bare.Track == named.Track || bare.Track == named.Artist + " " + named.Track || bare.Track == named.Track + " " + named.Artist)
                return new(SongMatch.Unsure, "same song and length, but one file name has no artist");
        }

        // Typos and spelling variants ("Alice DJ" / "Alice Deejay"): only with the same length, and never automatic.
        if (sameLength && a.Kind == b.Kind && a.Artist.Length > 0 && b.Artist.Length > 0)
        {
            var sa = a.Artist + " " + a.Track;
            var sb = b.Artist + " " + b.Track;
            if (Math.Min(sa.Length, sb.Length) >= 8 && Similarity(sa, sb) >= 0.85)
                return new(SongMatch.Unsure, "names almost match and the length is the same");
        }

        return new(SongMatch.Different, "different songs");
    }

    private static bool SameMarkers(SongId a, SongId b) =>
        a.Markers.Count == b.Markers.Count && a.Markers.All(kv => b.Markers.TryGetValue(kv.Key, out var n) && n == kv.Value);

    private static string Describe(SongId s) => s.Markers.Count == 0 ? "plain" : s.MarkerText;

    /// <summary>Lowercase, no accents, straight quotes, "&amp;" as "and".</summary>
    public static string Fold(string s)
    {
        var d = s.Replace('’', '\'').Replace('‘', '\'').Replace('´', '\'').Replace("&", " and ").Replace("+", " and ")
                 .Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(d.Length);
        foreach (var c in d)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(char.ToLowerInvariant(c));
        return sb.ToString().Normalize(NormalizationForm.FormC);
    }

    /// <summary>The bare name: no brackets, years, "official video" words, version words, feat., punctuation or leading "the".</summary>
    public static string Norm(string part)
    {
        var t = Fold(part);
        t = Feat().Replace(t, "");
        t = Brackets().Replace(t, " ");
        t = Year().Replace(t, " ");
        t = PlainVersion().Replace(t, " ");
        t = Noise().Replace(t, " ");
        t = MarkerWords().Replace(t, " ");
        t = t.Replace("'", "");
        t = Regex.Replace(t, @"[^\p{L}\p{N}]+", " ").Trim();
        if (t.StartsWith("the ", StringComparison.Ordinal)) t = t[4..];
        return t;
    }

    /// <summary>1 - edit distance / longer length.</summary>
    public static double Similarity(string a, string b)
    {
        if (a == b) return 1;
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) prev[j] = j;
        for (var i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            for (var j = 1; j <= b.Length; j++)
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (prev, cur) = (cur, prev);
        }
        return 1.0 - (double)prev[b.Length] / Math.Max(a.Length, b.Length);
    }
}
