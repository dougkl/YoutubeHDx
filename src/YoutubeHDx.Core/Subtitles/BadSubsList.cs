using System.Text.RegularExpressions;

namespace YoutubeHDx.Core.Subtitles;

/// <summary>
/// ".youtubehdx-badsubs.txt" in the download folder: one YouTube link or video ID per line, for subtitles you
/// think are wrong. The file is only ever added to (the NAS share allows appending, not editing): listing the
/// same video again means "still bad, try another one".
/// </summary>
public static partial class BadSubsList
{
    public const string FileName = ".youtubehdx-badsubs.txt";

    [GeneratedRegex(@"(?:[?&]v=|youtu\.be/|/shorts/|/live/|/embed/|\[)([\w-]{11})(?![\w-])")]
    private static partial Regex IdInLink();

    [GeneratedRegex(@"^[\w-]{11}$")]
    private static partial Regex BareId();

    public static string PathIn(string folder) => Path.Combine(folder, FileName);

    /// <summary>Video id from a link, a bare id, or a file name like "... [dQw4w9WgXcQ].mkv".</summary>
    public static string? ExtractId(string? text)
    {
        var t = (text ?? "").Trim();
        if (BareId().IsMatch(t)) return t;
        var m = IdInLink().Match(t);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>How many times each video was flagged.</summary>
    public static Dictionary<string, int> Read(string folder)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        var path = PathIn(folder);
        if (!File.Exists(path)) return counts;
        foreach (var raw in File.ReadLines(path))
        {
            var line = raw.Split('#', 2)[0].Trim();
            if (ExtractId(line) is { } id) counts[id] = counts.GetValueOrDefault(id) + 1;
        }
        return counts;
    }

    /// <summary>Adds a line (creating the file with instructions the first time). Returns the id, or null.</summary>
    public static string? Add(string folder, string linkOrId, string? note = null)
    {
        var id = ExtractId(linkOrId);
        if (id is null) return null;
        var path = PathIn(folder);
        if (!File.Exists(path))
        {
            File.AppendAllText(path,
                "# YoutubeHDx: videos whose subtitles are wrong. One YouTube link or video ID per line.\n" +
                "# The next subtitle scan adds better ones (song lyrics with matching timing).\n" +
                "# Still wrong after that? Add the same video again and the scan tries another source.\n");
        }
        File.AppendAllText(path, $"{id}  # {DateTime.Now:yyyy-MM-dd}{(string.IsNullOrWhiteSpace(note) ? "" : " " + note.Replace('\n', ' '))}\n");
        return id;
    }
}
