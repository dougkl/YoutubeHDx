using System.Text;
using System.Text.RegularExpressions;

namespace YoutubeHDx.Core.Library;

/// <summary>
/// Reads and writes the YoutubeHDx part of a folder's .plexignore. Your own lines in the file are kept as they are;
/// ours live between two marker comments and are rewritten as a whole.
/// </summary>
public static partial class PlexIgnore
{
    public const string FileName = ".plexignore";
    public const string BlockStart = "# >>> YoutubeHDx duplicates (managed by the downloader: change them in its Duplicates tab)";
    public const string BlockEnd = "# <<< YoutubeHDx duplicates";

    /// <summary>
    /// The pattern for one file name. Plex treats some characters specially and doesn't document how to escape them
    /// (brackets and parentheses are known to misbehave), so each of them becomes "*". Always check the result with
    /// <see cref="Matches"/> against the other files before using it.
    /// </summary>
    public static string PatternFor(string fileName)
    {
        var sb = new StringBuilder(fileName.Length);
        foreach (var c in fileName)
        {
            var special = c is '(' or ')' or '[' or ']' or '{' or '}' or '+' or '?' or '^' or '$' or '|' or '\\' or '*' or '#' or '!';
            if (special) { if (sb.Length == 0 || sb[^1] != '*') sb.Append('*'); }
            else sb.Append(c);
        }
        return sb.ToString();
    }

    /// <summary>Whether a pattern (with "*" wildcards) matches a file name, the way Plex would (case-insensitive).</summary>
    public static bool Matches(string pattern, string fileName) =>
        Regex.IsMatch(fileName, "^" + string.Join(".*", pattern.Split('*').Select(Regex.Escape)) + "$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Our current patterns in a folder's .plexignore.</summary>
    public static IReadOnlyList<string> ReadManaged(string dir)
    {
        var path = Path.Combine(dir, FileName);
        if (!File.Exists(path)) return [];
        var list = new List<string>();
        var inside = false;
        foreach (var line in File.ReadAllLines(path))
        {
            if (line == BlockStart) { inside = true; continue; }
            if (line == BlockEnd) { inside = false; continue; }
            if (inside && line.Length > 0 && !line.StartsWith('#')) list.Add(line);
        }
        return list;
    }

    /// <summary>
    /// Replaces our block with <paramref name="patterns"/> (removes it when empty), keeping every other line.
    /// Rewrites the file in place (the NAS allows changing files, and .plexignore is often hidden). Returns true if it changed.
    /// </summary>
    public static bool WriteManaged(string dir, IReadOnlyCollection<string> patterns)
    {
        var path = Path.Combine(dir, FileName);
        var exists = File.Exists(path);
        if (!exists && patterns.Count == 0) return false;

        var kept = new List<string>();
        if (exists)
        {
            var inside = false;
            foreach (var line in File.ReadAllLines(path))
            {
                if (line == BlockStart) { inside = true; continue; }
                if (line == BlockEnd) { inside = false; continue; }
                if (!inside) kept.Add(line);
            }
            while (kept.Count > 0 && kept[^1].Length == 0) kept.RemoveAt(kept.Count - 1);
        }

        var lines = new List<string>(kept);
        if (patterns.Count > 0)
        {
            if (lines.Count > 0) lines.Add("");
            lines.Add(BlockStart);
            lines.AddRange(patterns.OrderBy(p => p, StringComparer.OrdinalIgnoreCase));
            lines.Add(BlockEnd);
        }
        var text = lines.Count == 0 ? "" : string.Join("\n", lines) + "\n";
        if (exists && File.ReadAllText(path) == text) return false;

        using var fs = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
        fs.SetLength(0);
        var bytes = new UTF8Encoding(false).GetBytes(text);
        fs.Write(bytes);
        return true;
    }
}
