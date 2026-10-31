using System.Globalization;
using System.Text;

namespace YoutubeHDx.Core;

/// <summary>Cookie as sent by the extension (shape of chrome.cookies.Cookie).</summary>
public sealed record BrowserCookie(
    string Domain,
    bool HostOnly,
    string Path,
    bool Secure,
    bool HttpOnly,
    bool Session,
    double? ExpirationDate,
    string Name,
    string Value);

public static class CookieFile
{
    /// <summary>Writes cookies in the Netscape format that yt-dlp's --cookies option reads.</summary>
    public static void WriteNetscape(string path, IEnumerable<BrowserCookie> cookies)
    {
        var sb = new StringBuilder();
        sb.Append("# Netscape HTTP Cookie File\n");
        sb.Append("# Written by YoutubeHDx from your browser session. Do not share this file.\n\n");

        foreach (var c in cookies)
        {
            if (string.IsNullOrEmpty(c.Name) || string.IsNullOrEmpty(c.Domain)) continue;
            if (ContainsTabOrNewline(c.Name) || ContainsTabOrNewline(c.Value)) continue;

            var domain = c.Domain;
            if (!c.HostOnly && !domain.StartsWith('.')) domain = "." + domain;
            var includeSubdomains = domain.StartsWith('.') ? "TRUE" : "FALSE";
            var expiry = c.Session || c.ExpirationDate is null ? 0L : (long)c.ExpirationDate.Value;

            if (c.HttpOnly) sb.Append("#HttpOnly_");
            sb.Append(domain).Append('\t')
              .Append(includeSubdomains).Append('\t')
              .Append(string.IsNullOrEmpty(c.Path) ? "/" : c.Path).Append('\t')
              .Append(c.Secure ? "TRUE" : "FALSE").Append('\t')
              .Append(expiry.ToString(CultureInfo.InvariantCulture)).Append('\t')
              .Append(c.Name).Append('\t')
              .Append(c.Value).Append('\n');
        }

        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>True if the cookie file holds a signed-in YouTube session (LOGIN_INFO is only set when signed in).</summary>
    public static bool HasLogin(string path)
    {
        if (!File.Exists(path)) return false;
        foreach (var line in File.ReadLines(path))
        {
            var cols = line.Split('\t');
            if (cols.Length >= 7 && cols[5] == "LOGIN_INFO" && cols[0].Contains("youtube.com", StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    private static bool ContainsTabOrNewline(string s) => s.AsSpan().IndexOfAny('\t', '\n', '\r') >= 0;
}
