using System.Text.RegularExpressions;

namespace YoutubeHDx.Core.Lyrics;

public sealed record SongGuess(string Artist, string Track);

/// <summary>Artist and song from a YouTube title (same rules as the Player extension's lyrics.js).</summary>
public static partial class SongTitle
{
    [GeneratedRegex(@"\s*[(\[{][^)\]}]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k|remaster(ed)?|mv|clip|explicit|stereo|mono|music)\b[^)\]}]*[)\]}]",
        RegexOptions.IgnoreCase)]
    private static partial Regex Noise();

    [GeneratedRegex(@"\s+(official\s+(music\s+)?video|official\s+audio|music\s+video|lyric\s+video)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex TrailingNoise();

    [GeneratedRegex(@"\s*[(\[]?\s*\b(feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex Feat();

    [GeneratedRegex(@"^(.+?)\s+[-–—]\s+(.+)$")]
    private static partial Regex ArtistDashTrack();

    [GeneratedRegex(@"\s+[-–—]\s+[^-–—]*\b(video|remaster(ed)?|version|official)\b[^-–—]*$", RegexOptions.IgnoreCase)]
    private static partial Regex DashTail();

    public static string CleanPart(string? s)
    {
        var t = (s ?? "").Replace('’', '\'').Replace('‘', '\'').Replace('´', '\'');  // "Don’t" -> "Don't" (LRCLIB uses straight quotes)
        t = Noise().Replace(t, "");
        t = DashTail().Replace(t, "");                                               // "Live Is Life - Original Video 1985"

        t = Regex.Replace(t, @"\s+[|/]\s+.*$", "");
        t = TrailingNoise().Replace(t, "");
        t = t.Replace("\"", "").Replace("“", "").Replace("”", "");
        return Regex.Replace(t, @"\s{2,}", " ").Trim();
    }

    public static string CleanAuthor(string? author)
    {
        var a = (author ?? "").Trim();
        if (Regex.IsMatch(a, @"\s*-\s*Topic$", RegexOptions.IgnoreCase))
            return Regex.Replace(a, @"\s*-\s*Topic$", "", RegexOptions.IgnoreCase).Trim();
        if (a.EndsWith("VEVO", StringComparison.Ordinal))
            a = Regex.Replace(a[..^4], "([a-z])([A-Z])", "$1 $2"); // "SimpleMindsVEVO" -> "Simple Minds"
        return a.Trim();
    }

    public static string WithoutFeat(string track) => Feat().Replace(track, "").Trim();

    /// <summary>Possible (artist, track) pairs, best guess first, at most 3.</summary>
    public static IReadOnlyList<SongGuess> Guess(string? title, string? author)
    {
        var t = (title ?? "").Trim();
        var cleanAuthor = CleanAuthor(author);
        var list = new List<SongGuess>();
        void Add(string artist, string track)
        {
            artist = CleanPart(artist);
            track = CleanPart(track);
            if (artist.Length == 0 || track.Length == 0) return;
            if (!list.Any(g => g.Artist.Equals(artist, StringComparison.OrdinalIgnoreCase) &&
                               g.Track.Equals(track, StringComparison.OrdinalIgnoreCase)))
                list.Add(new SongGuess(artist, track));
        }

        var m = ArtistDashTrack().Match(t);
        if (m.Success)
        {
            Add(m.Groups[1].Value, m.Groups[2].Value);
            Add(m.Groups[1].Value, WithoutFeat(CleanPart(m.Groups[2].Value)));
            if (cleanAuthor.Length > 0) Add(cleanAuthor, m.Groups[2].Value);
        }
        else if (cleanAuthor.Length > 0)
        {
            Add(cleanAuthor, t);
            Add(cleanAuthor, WithoutFeat(CleanPart(t)));
        }
        return list.Take(3).ToList();
    }
}
