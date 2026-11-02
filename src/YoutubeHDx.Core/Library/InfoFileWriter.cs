using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using YoutubeHDx.Core.Lyrics;
using YoutubeHDx.Core.Subtitles;

namespace YoutubeHDx.Core.Library;

public sealed record InfoSummary(int Nfos, int Pictures, int Failed)
{
    public string Describe() => $"{Nfos} info file(s) and {Pictures} picture(s) added" + (Failed > 0 ? $", {Failed} failed" : "");
}

/// <summary>
/// Writes "Name [id].nfo" and "Name [id].jpg" next to each video so media players show the artist, song and a picture
/// instead of guessing from the file name. The .nfo uses the &lt;movie&gt; layout, which the Plex NFO agent
/// (Plex Media Server 1.43.1+), Jellyfin, Emby and Kodi all read, plus &lt;artist&gt;/&lt;album&gt; for players that know them.
/// Only creates files that are missing; never edits or replaces anything.
/// </summary>
public sealed partial class InfoFileWriter
{
    private static readonly string[] VideoExtensions = [".mkv", ".mp4", ".webm"];
    private static readonly string[] PictureExtensions = [".jpg", ".jpeg", ".png", ".webp"];

    private readonly Func<AppSettings> _settings;
    private readonly IMediaProbe _probe;
    private readonly HttpClient _http;
    private readonly Action<string> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public InfoFileWriter(Func<AppSettings> settings, IMediaProbe probe, HttpClient http, Action<string> log)
    {
        _settings = settings;
        _probe = probe;
        _http = http;
        _log = log;
    }

    [GeneratedRegex(@"\[([\w-]{11})\]\.[^.\\/]+$")]
    private static partial Regex IdInFileName();

    /// <summary>Every video under the NAS folder that is missing its .nfo or picture.</summary>
    public async Task<InfoSummary> WriteAllAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var root = _settings().NasPath;
            if (!Directory.Exists(root)) throw new InvalidOperationException($"NAS folder '{root}' is not reachable.");
            int nfos = 0, pics = 0, failed = 0;
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                         .Where(f => VideoExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                         .OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList())
            {
                var (nfo, pic, ok) = await WriteOneAsync(root, file, ct).ConfigureAwait(false);
                if (nfo) nfos++;
                if (pic) pics++;
                if (!ok) failed++;
            }
            var summary = new InfoSummary(nfos, pics, failed);
            if (nfos + pics + failed > 0) _log($"Info files: {summary.Describe()}");
            return summary;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>One video (right after it was downloaded).</summary>
    public async Task<InfoSummary> WriteForAsync(string video, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var (nfo, pic, ok) = await WriteOneAsync(_settings().NasPath, video, ct).ConfigureAwait(false);
            return new InfoSummary(nfo ? 1 : 0, pic ? 1 : 0, ok ? 0 : 1);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<(bool Nfo, bool Picture, bool Ok)> WriteOneAsync(string root, string video, CancellationToken ct)
    {
        var m = IdInFileName().Match(Path.GetFileName(video));
        if (!m.Success || !File.Exists(video)) return (false, false, true);
        var id = m.Groups[1].Value;
        var dir = Path.GetDirectoryName(video)!;
        var stem = Path.GetFileNameWithoutExtension(video);
        var nfoPath = Path.Combine(dir, stem + ".nfo");
        var needNfo = !File.Exists(nfoPath);
        var needPicture = !PictureExtensions.Any(e => File.Exists(Path.Combine(dir, stem + e)));
        if (!needNfo && !needPicture) return (false, false, true); // the common case: nothing to read at all

        MediaInfo? media = null;
        try
        {
            media = await _probe.ProbeAsync(video, ct).ConfigureAwait(false);
            var wroteNfo = false;
            if (needNfo)
            {
                if (media is null) { _log($"Info files: can't read {Path.GetFileName(video)} (ffprobe failed)"); return (false, false, false); }
                var playlist = Path.GetRelativePath(root, dir) is var rel && rel != "." && rel != "Singles" ? rel : null;
                wroteNfo = CreateNew(nfoPath, BuildNfo(id, video, media, playlist));
            }

            var wrotePicture = false;
            if (needPicture)
            {
                var jpg = await DownloadThumbnailAsync(id, ct).ConfigureAwait(false);
                if (jpg is null && media is { Duration: > 0 })
                    jpg = await _probe.GrabFrameAsync(video, Math.Min(media.Duration * 0.3, 60), ct).ConfigureAwait(false);
                if (jpg is not null) wrotePicture = CreateNew(Path.Combine(dir, stem + ".jpg"), jpg);
            }
            return (wroteNfo, wrotePicture, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log($"Info files: failed for {Path.GetFileName(video)}: {e.Message}");
            return (false, false, false);
        }
    }

    private async Task<byte[]?> DownloadThumbnailAsync(string id, CancellationToken ct)
    {
        foreach (var name in new[] { "maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg" })
        {
            try
            {
                using var r = await _http.GetAsync($"https://i.ytimg.com/vi/{id}/{name}", ct).ConfigureAwait(false);
                if (!r.IsSuccessStatusCode) continue;
                var bytes = await r.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
                if (bytes.Length > 2000) return bytes; // YouTube's "no thumbnail" placeholder is tiny
            }
            catch (HttpRequestException) { return null; }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return null; } // timeout
        }
        return null;
    }

    private static bool CreateNew(string path, byte[] bytes)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
            fs.Write(bytes);
            return true;
        }
        catch (IOException) when (File.Exists(path))
        {
            return false; // someone else made it meanwhile
        }
    }

    /// <summary>The .nfo text for one video.</summary>
    public static byte[] BuildNfo(string id, string video, MediaInfo media, string? playlist)
    {
        var youtubeTitle = media.Title ?? Subtitles.SubtitleScanner.TitleFromFileName(video);
        var channel = media.Artist;
        var guess = SongTitle.Guess(youtubeTitle, channel) is { Count: > 0 } g ? g[0] : null;
        var artist = guess?.Artist ?? SongTitle.CleanAuthor(channel);
        var song = guess?.Track ?? SongTitle.CleanPart(youtubeTitle);
        if (song.Length == 0) song = youtubeTitle;
        var title = string.IsNullOrWhiteSpace(artist) ? song : $"{artist} - {song}";
        var link = $"https://www.youtube.com/watch?v={id}";
        var uploaded = ParseDate(media.Tag("date", "upload_date"));
        var description = media.Tag("description", "synopsis", "comment") is { } d && !d.StartsWith("http", StringComparison.Ordinal) ? d : null;

        var plot = new StringBuilder();
        if (description is not null) plot.Append(description.Trim()).Append("\n\n");
        plot.Append("YouTube: ").Append(link);
        if (uploaded is { } u) plot.Append(" (uploaded ").Append(u.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)).Append(')');

        var movie = new XElement("movie",
            new XElement("title", title),
            new XElement("originaltitle", youtubeTitle),
            new XElement("sorttitle", title),
            string.IsNullOrWhiteSpace(artist) ? null : new XElement("artist", artist),
            media.Tag("album") is { } album ? new XElement("album", album) : null,
            new XElement("plot", plot.ToString()),
            new XElement("outline", title),
            media.Duration > 0 ? new XElement("runtime", Math.Max(1, (int)Math.Round(media.Duration / 60))) : null,
            new XElement("genre", media.Tag("genre") ?? "Music"),
            string.IsNullOrWhiteSpace(artist) ? null : new XElement("set", new XElement("name", artist)),
            playlist is null ? null : new XElement("tag", playlist),
            new XElement("tag", "YouTube"),
            string.IsNullOrWhiteSpace(artist) ? null : new XElement("actor", new XElement("name", artist), new XElement("role", "Artist")),
            string.IsNullOrWhiteSpace(channel) ? null : new XElement("studio", SongTitle.CleanAuthor(channel)),
            uploaded is { } up ? new XElement("dateadded", up.ToString("yyyy-MM-dd 00:00:00", CultureInfo.InvariantCulture)) : null,
            new XElement("uniqueid", new XAttribute("type", "youtube"), new XAttribute("default", "true"), id),
            new XElement("thumb", new XAttribute("aspect", "poster"), $"https://i.ytimg.com/vi/{id}/maxresdefault.jpg"));

        var settings = new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = true, IndentChars = "  " };
        using var ms = new MemoryStream();
        using (var w = XmlWriter.Create(ms, settings))
            new XDocument(new XDeclaration("1.0", "utf-8", "yes"), movie).Save(w);
        return ms.ToArray();
    }

    private static DateTime? ParseDate(string? v)
    {
        if (string.IsNullOrWhiteSpace(v)) return null;
        foreach (var f in new[] { "yyyyMMdd", "yyyy-MM-dd" })
            if (DateTime.TryParseExact(v.Trim(), f, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) return d;
        return null;
    }
}
