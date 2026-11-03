using System.Net;
using System.Text;
using System.Text.Json;
using YoutubeHDx.Core;
using YoutubeHDx.Core.Library;
using YoutubeHDx.Core.Tidal;

namespace YoutubeHDx.Tests;

/// <summary>A tiny fake of TIDAL's openapi v2 (JSON:API shapes as in the published OpenAPI spec).</summary>
internal sealed class FakeTidal : HttpMessageHandler
{
    public sealed record Track(string Id, string Title, string? Version, string Duration, string[] Artists, string[]? Tags = null);

    public Dictionary<string, Track[]> Search { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> Requests { get; } = new();
    public List<string> Added { get; } = new();
    public List<string> Bodies { get; } = new();
    public int Playlists { get; private set; }
    public bool PlaylistGone { get; set; }

    private IEnumerable<Track> All => Search.Values.SelectMany(x => x);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var url = Uri.UnescapeDataString(req.RequestUri!.PathAndQuery);
        Requests.Add($"{req.Method} {url}");
        Assert.Equal("Bearer test-token", req.Headers.Authorization?.ToString());
        if (req.Content is not null) Bodies.Add(await req.Content.ReadAsStringAsync(ct));

        if (url.StartsWith("/v2/searchResults?"))
        {
            var q = url.Split("filter[query]=")[1].Split('&')[0];
            var hits = Search.GetValueOrDefault(q) ?? [];
            return Json(new
            {
                data = new[] { new { id = q, type = "searchResults", relationships = new { tracks = new { data = hits.Select(h => new { id = h.Id, type = "tracks" }) } } } },
            });
        }
        if (url.StartsWith("/v2/tracks?"))
        {
            var ids = url.Split('&').Where(p => p.StartsWith("filter[id]=") || p.Contains("?filter[id]=")).Select(p => p.Split('=')[1]).ToHashSet();
            var tracks = All.Where(t => ids.Contains(t.Id)).DistinctBy(t => t.Id).ToList();
            return Json(new
            {
                data = tracks.Select(t => new
                {
                    id = t.Id, type = "tracks",
                    attributes = new { title = t.Title, version = t.Version, duration = t.Duration, mediaTags = t.Tags ?? ["LOSSLESS"], isrc = "X" },
                    relationships = new { artists = new { data = t.Artists.Select(a => new { id = "a-" + a, type = "artists" }) } },
                }),
                included = tracks.SelectMany(t => t.Artists).Distinct().Select(a => new { id = "a-" + a, type = "artists", attributes = new { name = a } }),
            });
        }
        if (req.Method == HttpMethod.Post && url == "/v2/playlists")
        {
            Playlists++;
            return Json(new { data = new { id = "pl-" + Playlists, type = "playlists" } }, HttpStatusCode.Created);
        }
        if (req.Method == HttpMethod.Get && url.StartsWith("/v2/playlists/") && !url.Contains("/relationships/"))
            return PlaylistGone ? new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") } : Json(new { data = new { id = "x" } });
        if (req.Method == HttpMethod.Post && url.Contains("/relationships/items"))
        {
            using var doc = JsonDocument.Parse(Bodies[^1]);
            Added.AddRange(doc.RootElement.GetProperty("data").EnumerateArray().Select(d => d.GetProperty("id").GetString()!));
            return Json(new { });
        }
        if (req.Method == HttpMethod.Get && url.Contains("/relationships/items"))
        {
            // two pages, to exercise links.next
            var all = Added.Select((id, i) => new { id, type = "tracks", meta = new { itemId = "item-" + id } }).ToList();
            var second = url.Contains("page[cursor]=2");
            var page = second ? all.Skip(1).ToList() : all.Take(1).ToList();
            return Json(new { data = page, links = new { self = "x", next = !second && all.Count > 1 ? "/playlists/p/relationships/items?page[cursor]=2" : null } });
        }
        if (req.Method == HttpMethod.Delete && url.Contains("/relationships/items"))
        {
            using var doc = JsonDocument.Parse(Bodies[^1]);
            foreach (var d in doc.RootElement.GetProperty("data").EnumerateArray())
            {
                Assert.Equal("item-" + d.GetProperty("id").GetString(), d.GetProperty("meta").GetProperty("itemId").GetString());
                Added.Remove(d.GetProperty("id").GetString()!);
            }
            return Json(new { });
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") };
    }

    private static HttpResponseMessage Json(object o, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(o), Encoding.UTF8, "application/vnd.api+json") };
}

internal static class TidalTests
{
    private static (BetterAudioPlaylist Builder, FakeTidal Fake, string Nas) Make()
    {
        var s = TestEnv.UseFakeYtDlp("ok");
        var nas = Path.Combine(TestEnv.Root, "tidal-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(nas);
        s.NasPath = nas;
        SettingsStore.Save(s);
        if (File.Exists(BetterAudioPlaylist.StateFile)) File.Delete(BetterAudioPlaylist.StateFile);
        var fake = new FakeTidal();
        var api = new TidalApi(new HttpClient(fake), _ => Task.FromResult("test-token"), "US", TimeSpan.Zero);
        return (new BetterAudioPlaylist(SettingsStore.Load, api, _ => { }), fake, nas);
    }

    private static FileFacts Video(string nas, string name, double seconds, string? artistTag = null) =>
        new(Path.Combine(nas, name), 1000, 1, seconds, 1920, 1080, 1_000_000, null, artistTag);

    [Test]
    public static void DurationsAreIso8601()
    {
        Assert.Equal(178.0, TidalApi.Seconds("PT2M58S"));
        Assert.Equal(3725.5, TidalApi.Seconds("PT1H2M5.5S"));
        Assert.Equal(0.0, TidalApi.Seconds("nonsense"));
    }

    [Test]
    public static void PkceChallengeIsTheHashOfTheVerifier()
    {
        var p = TidalAuth.NewPkce();
        var expected = Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(Encoding.ASCII.GetBytes(p.Verifier)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Equal(expected, p.Challenge);
        var url = TidalAuth.BuildAuthorizeUrl("my-client", p);
        Assert.Contains("code_challenge_method=S256", url);
        Assert.Contains("redirect_uri=http%3A%2F%2Flocalhost%3A51735%2Ftidal-callback", url);
        Assert.Contains("scope=search.read%20playlists.read%20playlists.write", url);
        Assert.Equal("a b", TidalAuth.ParseQuery("x=a+b&code=1")["x"]);
    }

    [Test]
    public static async Task SignInWorksThroughTheLocalhostRedirectAndThroughAPastedAddress()
    {
        TestEnv.UseFakeYtDlp("ok");
        var forms = new List<string>();
        var http = new HttpClient(new FakeHttp(r =>
        {
            forms.Add(r.Content!.ReadAsStringAsync().Result);
            return FakeHttp.Json("""{"access_token":"A","refresh_token":"R","expires_in":3600,"user_id":175}""");
        }));

        // 1. The browser follows the redirect to the app's localhost page.
        var t = await TidalAuth.SignInAsync(http, "cid", url =>
        {
            var state = TidalAuth.ParseQuery(url[(url.IndexOf('?') + 1)..])["state"];
            _ = Task.Run(async () =>
            {
                using var c = new System.Net.Sockets.TcpClient();
                await c.ConnectAsync(System.Net.IPAddress.Loopback, TidalAuth.CallbackPort);
                var s = c.GetStream();
                await s.WriteAsync(Encoding.ASCII.GetBytes($"GET /tidal-callback?code=C1&state={state} HTTP/1.1\r\nHost: localhost\r\n\r\n"));
                await new StreamReader(s).ReadToEndAsync();
            });
        }, CancellationToken.None);
        Assert.Equal("A", t.AccessToken);
        Assert.Contains("code=C1", forms[^1]);
        Assert.Contains("code_verifier=", forms[^1]);
        Assert.Equal("A", TidalAuth.Load()!.AccessToken);

        // 2. The browser can't open localhost; you paste the address it shows.
        string? state2 = null;
        t = await TidalAuth.SignInAsync(http, "cid", url => state2 = TidalAuth.ParseQuery(url[(url.IndexOf('?') + 1)..])["state"],
            CancellationToken.None, async ct => { while (state2 is null) await Task.Delay(10, ct); return $"http://localhost:51735/tidal-callback?code=C2&state={state2}"; });
        Assert.Contains("code=C2", forms[^1]);
        TidalAuth.SignOut();
    }

    [Test]
    public static void OnlyTheSameRecordingAtTheSameLengthIsPicked()
    {
        var video = SongKey.Parse("The Beatles - Let It Be (Official Music Video)");
        var tracks = new List<TidalTrack>
        {
            new("1", "Let It Be", "Live", 243, ["The Beatles"], ["LOSSLESS"], null),          // live: another song
            new("2", "Let It Be", "Remastered 2009", 243.5, ["The Beatles"], ["LOSSLESS"], null),
            new("3", "Let It Be", null, 243, ["Some Cover Band"], ["HIRES_LOSSLESS"], null),  // another artist
            new("4", "Let It Be", null, 263, ["The Beatles"], ["HIRES_LOSSLESS"], null),       // 20 s longer
        };
        var (best, near) = BetterAudioPlaylist.Pick(video, 242.8, tracks);
        Assert.Equal("2", best!.Id);
        Assert.Equal("4", near!.Id);

        var (none, _) = BetterAudioPlaylist.Pick(video, 250, tracks);           // 6.5 s off: no
        Assert.Equal(null, none);
    }

    [Test]
    public static void SeveralTidalArtistsMatchTheVideosArtistList()
    {
        var video = SongKey.Parse("AronChupa & Little Sis Nora - Hole in the Roof (Official Music Video)");
        Assert.True(BetterAudioPlaylist.SameSong(video, new TidalTrack("1", "Hole in the Roof", null, 200, ["AronChupa", "Little Sis Nora"], [], null)));
        Assert.True(BetterAudioPlaylist.SameSong(SongKey.Parse("Fatboy Slim ft. Bootsy Collins - Weapon Of Choice"),
            new TidalTrack("2", "Weapon Of Choice", "Remastered", 200, ["Fatboy Slim", "Bootsy Collins"], [], null)));
        Assert.False(BetterAudioPlaylist.SameSong(SongKey.Parse("Alice DJ - Better Off Alone (Official Video)"),
            new TidalTrack("4", "Better Off Alone", "UK Short Cut", 173, ["Alice DJ"], [], null)));
        Assert.False(BetterAudioPlaylist.SameSong(SongKey.Parse("Def Leppard - Hysteria"),
            new TidalTrack("3", "Hysteria", "Long Version", 355, ["Def Leppard"], [], null)));
    }

    [Test]
    public static async Task BuildsThePlaylistAndKeepsItUpToDate()
    {
        var (builder, fake, nas) = Make();
        fake.Search["Pink Floyd Learning To Fly"] = [new("100", "Learning To Fly", "2011 Remaster", "PT4M53S", ["Pink Floyd"], ["HIRES_LOSSLESS"])];
        fake.Search["Robbie Williams Angels"] = [new("200", "Angels", null, "PT4M24S", ["Robbie Williams"])];
        var videos = new List<FileFacts>
        {
            Video(nas, "Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].mkv", 292.4),
            Video(nas, "Robbie Williams - Angels (Official Video).mkv", 249),      // video has an intro: 15 s shorter
            Video(nas, "Unknown Band - Nowhere Song.mkv", 200),
            Video(nas, "barracuda.mkv", 262),
        };

        var s = await builder.RunAsync(videos, CancellationToken.None);
        Assert.Equal(1, s.Matched);
        Assert.Equal(1, s.Added);
        Assert.Equal(1, s.LengthDiffers);
        Assert.Equal(2, s.NotFound);
        Assert.Equal("100", string.Join(",", fake.Added));
        Assert.Equal(1, fake.Playlists);
        Assert.Contains("\"accessType\":\"UNLISTED\"", fake.Bodies[0]);
        Assert.Contains("\"onDuplicates\":\"SKIP\"", fake.Bodies[^1]);

        var csv = File.ReadAllText(Path.Combine(nas, BetterAudioPlaylist.CsvName));
        Assert.Contains("in playlist (same length)", csv);
        Assert.Contains("https://tidal.com/browse/track/100", csv);
        Assert.Contains("on TIDAL, different length", csv);
        Assert.Contains("no artist in file name", csv);

        // Next run: nothing searched again, nothing added twice.
        var searches = fake.Requests.Count(r => r.Contains("searchResults"));
        s = await builder.RunAsync(videos, CancellationToken.None);
        Assert.Equal(searches, fake.Requests.Count(r => r.Contains("searchResults")));
        Assert.Equal(0, s.Added);
        Assert.Equal(1, fake.Added.Count);

        // You deleted the playlist in TIDAL: it's made again with every match.
        fake.PlaylistGone = true;
        s = await builder.RunAsync(videos, CancellationToken.None);
        Assert.Equal(2, fake.Playlists);
        Assert.Equal(1, s.Added);
        fake.PlaylistGone = false;

        // You take a track out yourself: it is not put back.
        fake.Added.Clear();
        s = await builder.RunAsync(videos, CancellationToken.None);
        Assert.Equal(0, s.Added);
        Assert.Equal(0, fake.Added.Count);
    }

    [Test]
    public static async Task TracksThatNoLongerMatchAreTakenOut()
    {
        var (builder, fake, nas) = Make();
        fake.Search["Pink Floyd Learning To Fly"] = [new("100", "Learning To Fly", null, "PT4M53S", ["Pink Floyd"])];
        fake.Search["Rush Tom Sawyer"] = [new("300", "Tom Sawyer", null, "PT4M33S", ["Rush"])];
        var floyd = Video(nas, "Pink Floyd - Learning To Fly.mkv", 292.4);
        var rush = Video(nas, "Rush - Tom Sawyer.mkv", 273);
        await builder.RunAsync([floyd, rush], CancellationToken.None);
        Assert.Equal("100,300", string.Join(",", fake.Added.OrderBy(x => x)));
        fake.Added.Add("999"); // a song you added yourself

        // The Rush video is gone from the library: its track leaves the playlist, yours stays.
        var s = await builder.RunAsync([floyd], CancellationToken.None);
        Assert.Equal(1, s.Removed);
        Assert.Equal("100,999", string.Join(",", fake.Added.OrderBy(x => x)));
    }
}
