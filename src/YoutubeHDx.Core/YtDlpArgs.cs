using System.Text;

namespace YoutubeHDx.Core;

/// <summary>Builds the yt-dlp argument list. Arguments go through ProcessStartInfo.ArgumentList, so no manual quoting.</summary>
public static class YtDlpArgs
{
    // Machine-readable markers parsed by YtDlpRunner.
    public const string ProgressMarker = "[HDX]";
    public const string StartMarker = "[HDXSTART]";
    public const string DoneMarker = "[HDXDONE]";

    public static List<string> Build(AppSettings s, DownloadJob job, string? cookiesFile)
    {
        var h = s.MaxHeight;
        var a = new List<string>
        {
            "--encoding", "utf-8",
            "--newline", "--no-colors",
            "--ignore-errors",                       // one bad video doesn't kill a playlist
            "--no-simulate", "--progress",           // --print below would otherwise imply simulate/quiet

            // Best video up to 4K (VP9/AV1) + best audio, merged losslessly into MKV.
            "-f", $"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b",
            "-S", $"res:{h},fps",
            "--merge-output-format", "mkv",
            "--remux-video", "mkv",

            // Human-made English subtitles only. Auto-generated captions are never requested.
            "--no-write-auto-subs",
            "--sub-langs", s.SubtitleLanguages,
            "--convert-subs", "srt",

            "--embed-metadata", "--embed-chapters",
            "--embed-thumbnail", "--convert-thumbnails", "jpg",

            // Download + merge locally, then yt-dlp moves the finished file to the NAS.
            "-P", $"home:{s.NasPath}",
            "-P", $"temp:{s.TempPath}",
            "-o", s.OutputTemplate,
            "--download-archive", s.ArchiveFile,

            "--progress-template",
            $"download:{ProgressMarker}%(info.id)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "--print", $"before_dl:{StartMarker}%(id)s|%(playlist_title|)s|%(title)s",
            "--print", $"after_move:{DoneMarker}%(filepath)s",
        };

        // yt-dlp: --embed-subs alone embeds and deletes the .srt; adding --write-subs keeps the sidecar too.
        if (s.EmbedSubtitles) a.Add("--embed-subs");
        if (!s.EmbedSubtitles || s.KeepSubtitleFiles) a.Add("--write-subs");

        if (!string.IsNullOrWhiteSpace(s.FfmpegLocation))
        {
            a.Add("--ffmpeg-location");
            a.Add(s.FfmpegLocation);
        }

        if (cookiesFile is not null && File.Exists(cookiesFile))
        {
            a.Add("--cookies");
            a.Add(cookiesFile);
        }

        if (job.NoPlaylist) a.Add("--no-playlist");
        else a.Add("--yes-playlist");

        a.AddRange(SplitCommandLine(s.ExtraArgs));

        a.Add("--");
        a.Add(job.Url);
        return a;
    }

    /// <summary>Splits a command line on whitespace, honouring double quotes.</summary>
    public static IEnumerable<string> SplitCommandLine(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) yield break;
        var current = new StringBuilder();
        var inQuotes = false;
        var hasToken = false;
        foreach (var ch in line)
        {
            if (ch == '"') { inQuotes = !inQuotes; hasToken = true; continue; }
            if (char.IsWhiteSpace(ch) && !inQuotes)
            {
                if (hasToken) { yield return current.ToString(); current.Clear(); hasToken = false; }
                continue;
            }
            current.Append(ch);
            hasToken = true;
        }
        if (hasToken) yield return current.ToString();
    }
}
