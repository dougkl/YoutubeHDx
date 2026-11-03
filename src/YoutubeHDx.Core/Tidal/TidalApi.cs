using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Xml;

namespace YoutubeHDx.Core.Tidal;

public sealed record TidalTrack(string Id, string Title, string? Version, double Seconds, IReadOnlyList<string> Artists,
    IReadOnlyList<string> MediaTags, string? Isrc)
{
    public string FullTitle => string.IsNullOrWhiteSpace(Version) ? Title : $"{Title} ({Version})";
    public string Quality => MediaTags.Contains("HIRES_LOSSLESS") ? "Hi-Res" : MediaTags.Contains("LOSSLESS") ? "Lossless" : MediaTags.Count > 0 ? string.Join("/", MediaTags) : "";
}

/// <summary>The few calls of TIDAL's official API (openapi.tidal.com/v2, JSON:API) the playlist builder needs.</summary>
public sealed class TidalApi
{
    public const string BaseUrl = "https://openapi.tidal.com/v2";
    private const string JsonApi = "application/vnd.api+json";

    private readonly HttpClient _http;
    private readonly Func<CancellationToken, Task<string>> _token;
    private readonly string _country;
    private readonly TimeSpan _spacing;
    private readonly SemaphoreSlim _pace = new(1, 1);
    private DateTimeOffset _next = DateTimeOffset.MinValue;

    public TidalApi(HttpClient http, Func<CancellationToken, Task<string>> accessToken, string countryCode = "US", TimeSpan? spacing = null)
    {
        _http = http;
        _token = accessToken;
        _country = countryCode;
        _spacing = spacing ?? TimeSpan.FromMilliseconds(300); // be gentle: ~3 requests a second
    }

    /// <summary>Top tracks for a search, with their artists, length and quality.</summary>
    public async Task<IReadOnlyList<TidalTrack>> SearchTracksAsync(string query, int max, CancellationToken ct)
    {
        if (query.Length > 250) query = query[..250];
        using var doc = await SendAsync(HttpMethod.Get,
            $"/searchResults?filter[query]={Uri.EscapeDataString(query)}&countryCode={_country}&include=tracks", null, ct).ConfigureAwait(false);
        var ids = new List<string>();
        foreach (var result in Items(doc.RootElement, "data"))
            if (result.TryGetProperty("relationships", out var rel) && rel.TryGetProperty("tracks", out var tr))
                ids.AddRange(Items(tr, "data").Select(x => x.GetProperty("id").GetString()!).Take(max));
        if (ids.Count == 0) return [];
        return await GetTracksAsync(ids.Take(max).ToList(), ct).ConfigureAwait(false);
    }

    /// <summary>Tracks by id (up to 20 per call), with artist names.</summary>
    public async Task<IReadOnlyList<TidalTrack>> GetTracksAsync(IReadOnlyList<string> ids, CancellationToken ct)
    {
        var all = new List<TidalTrack>();
        foreach (var chunk in ids.Chunk(20))
        {
            var filter = string.Join("&", chunk.Select(id => "filter[id]=" + Uri.EscapeDataString(id)));
            using var doc = await SendAsync(HttpMethod.Get, $"/tracks?{filter}&countryCode={_country}&include=artists", null, ct).ConfigureAwait(false);
            var artistNames = Items(doc.RootElement, "included")
                .Where(x => x.GetProperty("type").GetString() == "artists")
                .ToDictionary(x => x.GetProperty("id").GetString()!, x => Attr(x, "name") ?? "");
            var byId = new Dictionary<string, TidalTrack>();
            foreach (var t in Items(doc.RootElement, "data"))
            {
                var id = t.GetProperty("id").GetString()!;
                var artists = t.TryGetProperty("relationships", out var rel) && rel.TryGetProperty("artists", out var ar)
                    ? Items(ar, "data").Select(a => artistNames.GetValueOrDefault(a.GetProperty("id").GetString()!, "")).Where(n => n.Length > 0).ToList()
                    : new List<string>();
                var tags = t.TryGetProperty("attributes", out var at) && at.TryGetProperty("mediaTags", out var mt) && mt.ValueKind == JsonValueKind.Array
                    ? mt.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : new List<string>();
                byId[id] = new TidalTrack(id, Attr(t, "title") ?? "", Attr(t, "version"), Seconds(Attr(t, "duration")), artists, tags, Attr(t, "isrc"));
            }
            all.AddRange(chunk.Where(byId.ContainsKey).Select(id => byId[id])); // keep search order
        }
        return all;
    }

    /// <summary>Creates a playlist in your account and returns its id.</summary>
    public async Task<string> CreatePlaylistAsync(string name, string description, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new
        {
            data = new { type = "playlists", attributes = new { name, description, accessType = "UNLISTED" } },
        });
        using var doc = await SendAsync(HttpMethod.Post, "/playlists", body, ct).ConfigureAwait(false);
        return doc.RootElement.GetProperty("data").GetProperty("id").GetString()!;
    }

    /// <summary>Your playlist with this name, if there is one (so a second PC reuses it instead of making another).</summary>
    public async Task<string?> FindOwnPlaylistAsync(string name, CancellationToken ct)
    {
        string? path = $"/playlists?filter[owners.id]=me&countryCode={_country}";
        for (var page = 0; path is not null && page < 20; page++)
        {
            using var doc = await SendAsync(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
            foreach (var p in Items(doc.RootElement, "data"))
                if (Attr(p, "name") == name) return p.GetProperty("id").GetString();
            path = doc.RootElement.TryGetProperty("links", out var links) && links.TryGetProperty("next", out var next) &&
                   next.GetString() is { Length: > 0 } n
                ? (n.StartsWith("http", StringComparison.Ordinal) ? n[BaseUrl.Length..] : n)
                : null;
        }
        return null;
    }

    /// <summary>True if the playlist still exists (you may have deleted it in TIDAL).</summary>
    public async Task<bool> PlaylistExistsAsync(string id, CancellationToken ct)
    {
        try
        {
            using var doc = await SendAsync(HttpMethod.Get, $"/playlists/{Uri.EscapeDataString(id)}?countryCode={_country}", null, ct).ConfigureAwait(false);
            return true;
        }
        catch (TidalApiException e) when (e.Status == HttpStatusCode.NotFound) { return false; }
    }

    public sealed record PlaylistItem(string TrackId, string ItemId);

    /// <summary>The tracks in a playlist, with the item ids needed to remove them.</summary>
    public async Task<IReadOnlyList<PlaylistItem>> GetPlaylistItemsAsync(string playlistId, CancellationToken ct)
    {
        var items = new List<PlaylistItem>();
        string? path = $"/playlists/{Uri.EscapeDataString(playlistId)}/relationships/items?countryCode={_country}";
        for (var page = 0; path is not null && page < 200; page++)
        {
            using var doc = await SendAsync(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
            foreach (var d in Items(doc.RootElement, "data"))
                if (d.TryGetProperty("type", out var t) && t.GetString() == "tracks" &&
                    d.TryGetProperty("meta", out var m) && m.TryGetProperty("itemId", out var item))
                    items.Add(new PlaylistItem(d.GetProperty("id").GetString()!, item.GetString()!));
            path = doc.RootElement.TryGetProperty("links", out var links) && links.TryGetProperty("next", out var next) &&
                   next.GetString() is { Length: > 0 } n
                ? (n.StartsWith("http", StringComparison.Ordinal) ? n[BaseUrl.Length..] : n)
                : null;
        }
        return items;
    }

    /// <summary>Removes items (by their item ids) from a playlist, 50 per call.</summary>
    public async Task RemoveItemsAsync(string playlistId, IReadOnlyList<PlaylistItem> items, CancellationToken ct)
    {
        foreach (var chunk in items.Chunk(50))
        {
            var body = JsonSerializer.Serialize(new
            {
                data = chunk.Select(i => new { id = i.TrackId, type = "tracks", meta = new { itemId = i.ItemId } }).ToArray(),
            });
            using var _ = await SendAsync(HttpMethod.Delete, $"/playlists/{Uri.EscapeDataString(playlistId)}/relationships/items", body, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Adds tracks (50 per call); tracks already in the playlist are skipped.</summary>
    public async Task AddTracksAsync(string playlistId, IReadOnlyList<string> trackIds, CancellationToken ct)
    {
        foreach (var chunk in trackIds.Chunk(50))
        {
            var body = JsonSerializer.Serialize(new
            {
                data = chunk.Select(id => new { id, type = "tracks" }).ToArray(),
                meta = new { onDuplicates = "SKIP" },
            });
            using var _ = await SendAsync(HttpMethod.Post, $"/playlists/{Uri.EscapeDataString(playlistId)}/relationships/items", body, ct).ConfigureAwait(false);
        }
    }

    // ---------------------------------------------------------------- plumbing

    private async Task<JsonDocument> SendAsync(HttpMethod method, string path, string? body, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            await _pace.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var wait = _next - DateTimeOffset.Now;
                if (wait > TimeSpan.Zero) await Task.Delay(wait, ct).ConfigureAwait(false);
                _next = DateTimeOffset.Now + _spacing;
            }
            finally { _pace.Release(); }

            using var req = new HttpRequestMessage(method, BaseUrl + path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await _token(ct).ConfigureAwait(false));
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(JsonApi));
            if (body is not null)
            {
                req.Content = new StringContent(body, Encoding.UTF8);
                req.Content.Headers.ContentType = new MediaTypeHeaderValue(JsonApi);
                req.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
            }

            using var r = await _http.SendAsync(req, ct).ConfigureAwait(false);
            var text = await r.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (r.StatusCode == HttpStatusCode.TooManyRequests && attempt < 6)
            {
                var retry = r.Headers.RetryAfter?.Delta ?? TimeSpan.FromSeconds(5 * (attempt + 1));
                await Task.Delay(retry + TimeSpan.FromSeconds(1), ct).ConfigureAwait(false);
                continue;
            }
            if ((int)r.StatusCode >= 500 && attempt < 2)
            {
                await Task.Delay(TimeSpan.FromSeconds(3 * (attempt + 1)), ct).ConfigureAwait(false);
                continue;
            }
            if (!r.IsSuccessStatusCode) throw new TidalApiException(r.StatusCode, text);
            return JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
        }
    }

    private static IEnumerable<JsonElement> Items(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return [];
        if (v.ValueKind == JsonValueKind.Array) return v.EnumerateArray().ToList();
        return v.ValueKind == JsonValueKind.Object ? [v] : [];
    }

    private static string? Attr(JsonElement e, string name) =>
        e.TryGetProperty("attributes", out var a) && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>"PT3M45S" -> 225.</summary>
    public static double Seconds(string? iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return 0;
        try { return XmlConvert.ToTimeSpan(iso).TotalSeconds; }
        catch (FormatException) { return 0; }
    }
}

public sealed class TidalApiException(HttpStatusCode status, string body)
    : Exception($"TIDAL answered {(int)status}: {(body.Length > 300 ? body[..300] : body)}")
{
    public HttpStatusCode Status { get; } = status;
}
