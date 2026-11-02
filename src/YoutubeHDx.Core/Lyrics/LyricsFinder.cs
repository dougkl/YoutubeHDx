using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace YoutubeHDx.Core.Lyrics;

public sealed record LyricsResult(IReadOnlyList<Cue> Cues, string Source, string Id, string Matched);

/// <summary>Outcome of a lookup. Retryable = a source was unreachable, so "not found" must not stick for long.</summary>
public sealed record LyricsLookup(LyricsResult? Result, bool Retryable, string? Reason);

/// <summary>Finds synced lyrics for a video: LRCLIB first (free, no account), then OpenSubtitles if an API key is set.</summary>
public sealed class LyricsFinder
{
    private const string Lrclib = "https://lrclib.net/api";
    private const string OpenSubs = "https://api.opensubtitles.com/api/v1";
    private const string UserAgent = "YoutubeHDx/1.4 (https://github.com/dougkl/YoutubeHDx)";

    private readonly HttpClient _http;
    private readonly string? _openSubtitlesKey;

    private sealed class SourceDown(string message) : Exception(message);

    public LyricsFinder(HttpClient http, string? openSubtitlesKey)
    {
        _http = http;
        _openSubtitlesKey = string.IsNullOrWhiteSpace(openSubtitlesKey) ? null : openSubtitlesKey.Trim();
    }

    public async Task<LyricsLookup> FindAsync(string? title, string? author, double duration,
        IReadOnlyCollection<string> exclude, CancellationToken ct)
    {
        var guesses = SongTitle.Guess(title, author);
        if (guesses.Count == 0) return new(null, false, "could not tell artist and song from the title");
        if (duration <= 0) return new(null, true, "video length unknown");

        var retryable = false;
        try
        {
            var hit = await FromLrclibAsync(guesses, duration, exclude, ct).ConfigureAwait(false);
            if (hit is not null) return new(hit, false, null);
        }
        catch (SourceDown) { retryable = true; }

        if (_openSubtitlesKey is not null)
        {
            try
            {
                var hit = await FromOpenSubtitlesAsync(guesses, duration, exclude, ct).ConfigureAwait(false);
                if (hit is not null) return new(hit, false, null);
            }
            catch (SourceDown) { retryable = true; }
        }
        return new(null, retryable, "no lyrics with matching timing");
    }

    // ---------------------------------------------------------------- LRCLIB

    private async Task<LyricsResult?> FromLrclibAsync(IReadOnlyList<SongGuess> guesses, double duration,
        IReadOnlyCollection<string> exclude, CancellationToken ct)
    {
        foreach (var g in guesses)
        {
            var url = $"{Lrclib}/search?artist_name={Uri.EscapeDataString(g.Artist)}&track_name={Uri.EscapeDataString(g.Track)}";
            using var doc = await GetJsonAsync(new HttpRequestMessage(HttpMethod.Get, url), ct).ConfigureAwait(false);
            if (doc is null || doc.RootElement.ValueKind != JsonValueKind.Array) continue;

            JsonElement? best = null;
            var bestDiff = double.MaxValue;
            foreach (var r in doc.RootElement.EnumerateArray())
            {
                if (r.TryGetProperty("instrumental", out var ins) && ins.ValueKind == JsonValueKind.True) continue;
                if (!r.TryGetProperty("syncedLyrics", out var syn) || syn.ValueKind != JsonValueKind.String || syn.GetString()!.Length == 0) continue;
                if (!r.TryGetProperty("duration", out var dur) || dur.ValueKind != JsonValueKind.Number) continue;
                if (r.TryGetProperty("id", out var id) && exclude.Contains($"lrclib:{id}")) continue;
                var diff = Math.Abs(dur.GetDouble() - duration);
                if (diff <= SubtitleText.ToleranceSeconds && diff < bestDiff) { best = r; bestDiff = diff; }
            }
            if (best is not { } hit) continue;

            var cues = SubtitleText.ParseLrc(hit.GetProperty("syncedLyrics").GetString(), duration);
            if (cues.Count == 0) continue;
            var lrcId = hit.TryGetProperty("id", out var hid) ? $"lrclib:{hid}" : "lrclib:?";
            var matched = $"{Str(hit, "artistName")} - {Str(hit, "trackName")} ({Math.Round(hit.GetProperty("duration").GetDouble())} s)";
            return new LyricsResult(cues, "LRCLIB", lrcId, matched);
        }
        return null;
    }

    // ---------------------------------------------------------------- OpenSubtitles

    private async Task<LyricsResult?> FromOpenSubtitlesAsync(IReadOnlyList<SongGuess> guesses, double duration,
        IReadOnlyCollection<string> exclude, CancellationToken ct)
    {
        foreach (var g in guesses)
        {
            var search = OsRequest(HttpMethod.Get,
                $"{OpenSubs}/subtitles?languages=en&query={Uri.EscapeDataString($"{g.Artist} {g.Track}")}");
            using var found = await GetJsonAsync(search, ct).ConfigureAwait(false);
            if (found is null || !found.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;

            var wanted = Norm(g.Track);
            foreach (var item in data.EnumerateArray())
            {
                if (!item.TryGetProperty("attributes", out var a)) continue;
                var fd = a.TryGetProperty("feature_details", out var f) ? f : default;
                var itemTitle = Norm(Str(fd, "title") ?? Str(fd, "movie_name") ?? Str(a, "release"));
                if (wanted.Length == 0 || !itemTitle.Contains(wanted, StringComparison.Ordinal)) continue;
                if (!a.TryGetProperty("files", out var files) || files.GetArrayLength() == 0) continue;
                var fileId = files[0].GetProperty("file_id").ToString();
                if (exclude.Contains($"os:{fileId}")) continue;

                var dl = OsRequest(HttpMethod.Post, $"{OpenSubs}/download");
                dl.Content = new StringContent(JsonSerializer.Serialize(new { file_id = long.Parse(fileId), sub_format = "srt" }),
                    Encoding.UTF8, "application/json");
                using var link = await GetJsonAsync(dl, ct).ConfigureAwait(false);
                var href = link is not null && link.RootElement.TryGetProperty("link", out var l) ? l.GetString() : null;
                if (href is null) continue;

                string srt;
                try
                {
                    using var res = await _http.GetAsync(href, ct).ConfigureAwait(false);
                    if (!res.IsSuccessStatusCode) throw new SourceDown($"download HTTP {(int)res.StatusCode}");
                    srt = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                }
                catch (HttpRequestException e) { throw new SourceDown(e.Message); }

                var cues = SubtitleText.ParseSrt(srt);
                if (SubtitleText.Problem(cues, duration) is null)
                    return new LyricsResult(cues, "OpenSubtitles", $"os:{fileId}", Str(fd, "title") ?? g.Track);
            }
        }
        return null;
    }

    private HttpRequestMessage OsRequest(HttpMethod method, string url)
    {
        var req = new HttpRequestMessage(method, url);
        req.Headers.Add("Api-Key", _openSubtitlesKey);
        return req;
    }

    // ---------------------------------------------------------------- helpers

    private async Task<JsonDocument?> GetJsonAsync(HttpRequestMessage req, CancellationToken ct)
    {
        req.Headers.UserAgent.ParseAdd(UserAgent);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        HttpResponseMessage res;
        try { res = await _http.SendAsync(req, ct).ConfigureAwait(false); }
        catch (HttpRequestException e) { throw new SourceDown(e.Message); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { throw new SourceDown("timeout"); }

        using (res)
        {
            if (res.StatusCode == HttpStatusCode.NotFound) return null;
            if (res.StatusCode == HttpStatusCode.TooManyRequests || (int)res.StatusCode >= 500)
                throw new SourceDown($"HTTP {(int)res.StatusCode}");
            if (!res.IsSuccessStatusCode) return null;
            try { return JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false)); }
            catch (JsonException) { throw new SourceDown("bad JSON"); }
        }
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string Norm(string? s)
    {
        var sb = new StringBuilder();
        foreach (var ch in (s ?? "").Normalize(NormalizationForm.FormKD).ToLowerInvariant())
            sb.Append(char.IsLetterOrDigit(ch) ? ch : ' ');
        return string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }
}
