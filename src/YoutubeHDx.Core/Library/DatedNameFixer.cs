using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace YoutubeHDx.Core.Library;

public sealed record RenameSummary(int Renamed, int Conflicts, int Failed)
{
    public string Describe() => $"{Renamed} file(s) renamed" +
                                (Conflicts > 0 ? $", {Conflicts} skipped (new name already taken)" : "") +
                                (Failed > 0 ? $", {Failed} failed" : "");
}

/// <summary>
/// Removes the upload date that versions up to 1.4.0 put in front of file names
/// ("2014-07-18 - Pink Floyd - Learning To Fly [nVhNCTH8pDs].mkv" -> "Pink Floyd - Learning To Fly [nVhNCTH8pDs].mkv"),
/// because Plex read the date as part of the artist/title. A video and its .srt/.nfo/.jpg files move together,
/// nothing is ever overwritten, and every rename is listed in renamed-files.csv (to undo it if ever needed).
/// </summary>
public static partial class DatedNameFixer
{
    public const string CsvName = "renamed-files.csv";

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2} - (?<rest>.*\[(?<id>[\w-]{11})\].*)$")]
    private static partial Regex Dated();

    private static readonly string[] Unfinished = [".part", ".ytdl", ".temp", ".tmp"];

    public static RenameSummary Fix(string root, Action<string> log, CancellationToken ct = default)
    {
        if (!Directory.Exists(root)) throw new InvalidOperationException($"NAS folder '{root}' is not reachable.");

        var groups = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(path => (path, m: Dated().Match(Path.GetFileName(path))))
            .Where(x => x.m.Success && !Unfinished.Any(u => x.path.EndsWith(u, StringComparison.OrdinalIgnoreCase)) &&
                        !x.path.Contains(".part-Frag", StringComparison.OrdinalIgnoreCase))
            .GroupBy(x => (Dir: Path.GetDirectoryName(x.path)!, Id: x.m.Groups["id"].Value))
            .OrderBy(g => g.Key.Dir, StringComparer.OrdinalIgnoreCase).ThenBy(g => g.Key.Id, StringComparer.Ordinal)
            .ToList();

        int renamed = 0, conflicts = 0, failed = 0;
        var csv = new StringBuilder();
        foreach (var g in groups)
        {
            ct.ThrowIfCancellationRequested();
            var moves = g.Select(x => (From: x.path, To: Path.Combine(g.Key.Dir, x.m.Groups["rest"].Value))).ToList();

            // All or nothing per video, so the .mkv and its .srt/.nfo/.jpg keep matching names.
            if (moves.Any(mv => File.Exists(mv.To) || Directory.Exists(mv.To)) ||
                moves.Select(mv => mv.To).Distinct(StringComparer.OrdinalIgnoreCase).Count() != moves.Count)
            {
                conflicts += moves.Count;
                log($"Rename skipped, name already taken: {Path.GetFileName(moves[0].To)}");
                continue;
            }

            foreach (var (from, to) in moves)
            {
                try
                {
                    File.Move(from, to, overwrite: false);
                    renamed++;
                    csv.Append(Csv(DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)))
                       .Append(',').Append(Csv(Path.GetRelativePath(root, g.Key.Dir)))
                       .Append(',').Append(Csv(Path.GetFileName(from)))
                       .Append(',').Append(Csv(Path.GetFileName(to))).Append("\r\n");
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    failed++;
                    log($"Rename failed for {Path.GetFileName(from)}: {e.Message}");
                }
            }
        }

        if (csv.Length > 0) AppendCsv(Path.Combine(root, CsvName), csv.ToString());
        var summary = new RenameSummary(renamed, conflicts, failed);
        if (renamed + conflicts + failed > 0) log($"Removing dates from file names: {summary.Describe()}");
        return summary;
    }

    private static void AppendCsv(string path, string rows)
    {
        try
        {
            var isNew = !File.Exists(path);
            using var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
            using var w = new StreamWriter(fs, new UTF8Encoding(isNew)); // BOM on a new file so Excel reads accents
            if (isNew) w.Write("renamed_at,folder,old_name,new_name\r\n");
            w.Write(rows);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // the renames themselves already happened; the list is only a record
        }
    }

    private static string Csv(string v) =>
        v.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;
}
