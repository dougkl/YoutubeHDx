using System.Text.RegularExpressions;

namespace YoutubeHDx.Core;

/// <summary>Turns yt-dlp error lines into something you can act on.</summary>
public static partial class FriendlyError
{
    [GeneratedRegex(@"^(ERROR:\s*)?(\[[^\]]+\]\s*)?([\w-]{11}:\s*)?")]
    private static partial Regex Prefix();

    private static readonly (Regex Pattern, string Text)[] Known =
    [
        (new(@"not a bot|cookies.*(no longer valid|expired)|login required", RegexOptions.IgnoreCase),
            "YouTube wants you signed in again: open YouTube in Chrome (signed in) and click the YoutubeHDx extension icon once"),
        (new(@"HTTP Error 403|Forbidden", RegexOptions.IgnoreCase),
            "YouTube refused the download (403). Usually fixed by updating yt-dlp (winget upgrade yt-dlp.yt-dlp)"),
        (new(@"HTTP Error 429|Too Many Requests", RegexOptions.IgnoreCase),
            "YouTube is limiting downloads right now (too many requests); it tries again on the next sync"),
        (new(@"getaddrinfo|Name or service not known|No such host|timed out|Connection (reset|refused|aborted)|Network is unreachable|Temporary failure", RegexOptions.IgnoreCase),
            "Could not reach YouTube (network problem); it tries again on the next sync"),
        (new(@"ffmpeg.*not (found|installed)|ffprobe.*not found", RegexOptions.IgnoreCase),
            "ffmpeg is missing: install it (winget install Gyan.FFmpeg)"),
        (new(@"No space left|disk full", RegexOptions.IgnoreCase),
            "No space left on the NAS or the temp drive"),
        (new(@"(Permission denied|Access is denied)", RegexOptions.IgnoreCase),
            "Windows refused to write a file (permission denied): check the NAS folder permissions"),
        (new(@"playlist does not exist|The playlist does not exist|This playlist (is private|type is unviewable)", RegexOptions.IgnoreCase),
            "The playlist can't be opened: it was deleted, made private, or the link is wrong"),
        (new(@"Requested format is not available", RegexOptions.IgnoreCase),
            "YouTube offered no downloadable format for this video. Updating yt-dlp usually fixes it"),
    ];

    public static string Describe(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Unknown problem; see the log (tray → Open log)";
        foreach (var (pattern, text) in Known)
            if (pattern.IsMatch(raw)) return text;
        var plain = Prefix().Replace(raw.Trim(), "").Trim();
        return plain.Length > 160 ? plain[..157] + "…" : plain;
    }
}
