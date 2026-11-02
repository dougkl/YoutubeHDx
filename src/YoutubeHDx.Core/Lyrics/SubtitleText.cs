using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace YoutubeHDx.Core.Lyrics;

/// <summary>One subtitle line, in seconds.</summary>
public sealed record Cue(double Start, double End, string Text);

public static partial class SubtitleText
{
    /// <summary>Lyrics' song length must be within this many seconds of the video, so the timing lines up.</summary>
    public const double ToleranceSeconds = 3;

    [GeneratedRegex(@"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")]
    private static partial Regex LrcStamp();

    [GeneratedRegex(@"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})")]
    private static partial Regex SrtTiming();

    /// <summary>LRC ("[01:23.45] line") -> cues. Blank lines end the previous line; lines are held at most 8 s.</summary>
    public static List<Cue> ParseLrc(string? lrc, double duration)
    {
        var stamps = new List<(double Start, string Text)>();
        foreach (var raw in (lrc ?? "").Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            var tags = LrcStamp().Matches(line);
            if (tags.Count == 0) continue;
            var last = tags[^1];
            var text = line[(last.Index + last.Length)..].Trim();
            foreach (Match tag in tags)
            {
                var frac = tag.Groups[3].Success ? double.Parse("0." + tag.Groups[3].Value, CultureInfo.InvariantCulture) : 0;
                stamps.Add((int.Parse(tag.Groups[1].Value) * 60 + int.Parse(tag.Groups[2].Value) + frac, text));
            }
        }
        stamps.Sort((a, b) => a.Start.CompareTo(b.Start));

        var cues = new List<Cue>();
        for (var i = 0; i < stamps.Count; i++)
        {
            if (stamps[i].Text.Length == 0) continue; // gap marker
            var end = i + 1 < stamps.Count ? stamps[i + 1].Start : stamps[i].Start + 6;
            end = Math.Min(end, stamps[i].Start + 8);
            if (duration > 0) end = Math.Min(end, duration);
            if (end > stamps[i].Start) cues.Add(new Cue(stamps[i].Start, end, stamps[i].Text));
        }
        return cues;
    }

    public static List<Cue> ParseSrt(string? srt)
    {
        static double Sec(Group h, Group m, Group s, Group ms) =>
            int.Parse(h.Value) * 3600 + int.Parse(m.Value) * 60 + int.Parse(s.Value) + int.Parse(ms.Value.PadRight(3, '0')) / 1000.0;

        var cues = new List<Cue>();
        foreach (var block in Regex.Split((srt ?? "").Replace("\r", ""), @"\n\s*\n"))
        {
            var t = SrtTiming().Match(block);
            if (!t.Success) continue;
            var text = block[(t.Index + t.Length)..];
            text = Regex.Replace(text, "<[^>]+>", "");
            text = Regex.Replace(text, @"\{\\[^}]*\}", "").Trim();
            if (text.Length > 0)
                cues.Add(new Cue(Sec(t.Groups[1], t.Groups[2], t.Groups[3], t.Groups[4]), Sec(t.Groups[5], t.Groups[6], t.Groups[7], t.Groups[8]), text));
        }
        cues.Sort((a, b) => a.Start.CompareTo(b.Start));
        return cues;
    }

    public static string ToSrt(IEnumerable<Cue> cues)
    {
        static string Ts(double s)
        {
            var t = TimeSpan.FromMilliseconds(Math.Round(Math.Max(0, s) * 1000));
            return $"{(int)t.TotalHours:00}:{t.Minutes:00}:{t.Seconds:00},{t.Milliseconds:000}";
        }
        var sb = new StringBuilder();
        var n = 1;
        foreach (var c in cues)
            sb.Append(n++).Append('\n').Append(Ts(c.Start)).Append(" --> ").Append(Ts(c.End)).Append('\n').Append(c.Text).Append("\n\n");
        return sb.ToString();
    }

    /// <summary>
    /// Do these subtitles plausibly belong to (and line up with) a video of this length?
    /// Returns null when fine, otherwise the reason they look bad.
    /// </summary>
    public static string? Problem(IReadOnlyList<Cue> cues, double duration)
    {
        if (cues.Count == 0) return "empty";
        if (cues.Count < 3) return "almost empty";
        if (duration <= 0) return null; // can't judge timing
        var lastEnd = cues.Max(c => c.End);
        if (cues[0].Start < 0) return "starts before the video";
        if (lastEnd > duration + ToleranceSeconds) return "runs past the end of the video (timed for a different cut)";
        if (lastEnd < duration * 0.3) return "covers only the start of the video";
        return null;
    }
}
