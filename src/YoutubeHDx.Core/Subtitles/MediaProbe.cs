using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace YoutubeHDx.Core.Subtitles;

public sealed record SubtitleStream(int Index, string? Language);

/// <summary>What the scanner needs to know about a video file.</summary>
public sealed record MediaInfo(double Duration, string? Title, string? Artist, IReadOnlyList<SubtitleStream> Subtitles);

public interface IMediaProbe
{
    Task<MediaInfo?> ProbeAsync(string path, CancellationToken ct);

    /// <summary>The Nth subtitle stream as SRT text (null if it can't be read).</summary>
    Task<string?> ExtractSubtitleAsync(string path, int subtitleIndex, CancellationToken ct);
}

/// <summary>ffprobe/ffmpeg from the same place the downloader uses (settings.ffmpegLocation, else PATH).</summary>
public sealed class FfmpegProbe : IMediaProbe
{
    private readonly Func<AppSettings> _settings;

    public FfmpegProbe(Func<AppSettings> settings) => _settings = settings;

    private string Tool(string name)
    {
        var loc = _settings().FfmpegLocation;
        if (string.IsNullOrWhiteSpace(loc)) return name;
        var dir = Directory.Exists(loc) ? loc : Path.GetDirectoryName(loc) ?? "";
        var candidate = Path.Combine(dir, OperatingSystem.IsWindows() ? name + ".exe" : name);
        return File.Exists(candidate) ? candidate : name;
    }

    public async Task<MediaInfo?> ProbeAsync(string path, CancellationToken ct)
    {
        var json = await RunAsync(Tool("ffprobe"), ct,
            "-v", "error",
            "-show_entries", "format=duration:format_tags:stream=index,codec_type:stream_tags=language",
            "-of", "json", "--", path).ConfigureAwait(false);
        if (json is null) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var format = root.TryGetProperty("format", out var f) ? f : default;
            var duration = format.ValueKind == JsonValueKind.Object && format.TryGetProperty("duration", out var d) &&
                           double.TryParse(d.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var dv) ? dv : 0;

            string? Tag(params string[] names)
            {
                if (format.ValueKind != JsonValueKind.Object || !format.TryGetProperty("tags", out var tags)) return null;
                foreach (var t in tags.EnumerateObject())
                    if (names.Any(n => n.Equals(t.Name, StringComparison.OrdinalIgnoreCase)) && t.Value.GetString() is { Length: > 0 } v)
                        return v;
                return null;
            }

            var subs = new List<SubtitleStream>();
            if (root.TryGetProperty("streams", out var streams))
            {
                var n = 0;
                foreach (var s in streams.EnumerateArray())
                {
                    if (s.TryGetProperty("codec_type", out var ctp) && ctp.GetString() == "subtitle")
                    {
                        var lang = s.TryGetProperty("tags", out var st) && st.TryGetProperty("language", out var l) ? l.GetString() : null;
                        subs.Add(new SubtitleStream(n++, lang));
                    }
                }
            }
            return new MediaInfo(duration, Tag("title"), Tag("artist", "uploader", "album_artist"), subs);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public Task<string?> ExtractSubtitleAsync(string path, int subtitleIndex, CancellationToken ct) =>
        RunAsync(Tool("ffmpeg"), ct, "-v", "error", "-i", path, "-map", $"0:s:{subtitleIndex}", "-f", "srt", "-");

    private static async Task<string?> RunAsync(string exe, CancellationToken ct, params string[] args)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi)!;
            var stdout = p.StandardOutput.ReadToEndAsync(ct);
            _ = p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct).ConfigureAwait(false);
            return p.ExitCode == 0 ? await stdout.ConfigureAwait(false) : null;
        }
        catch (Win32Exception)
        {
            return null; // ffprobe/ffmpeg not installed
        }
    }
}
