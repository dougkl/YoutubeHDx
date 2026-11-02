using System.Net;
using System.Text;
using YoutubeHDx.Core;
using YoutubeHDx.Core.Lyrics;
using YoutubeHDx.Core.Subtitles;

namespace YoutubeHDx.Tests;

/// <summary>Answers HTTP requests from a function, and records them.</summary>
internal sealed class FakeHttp(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
{
    public List<string> Urls { get; } = new();

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Urls.Add(request.RequestUri!.AbsoluteUri); // as sent (ToString() would decode %20)
        return Task.FromResult(answer(request));
    }

    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}

internal sealed class FakeProbe : IMediaProbe
{
    public Dictionary<string, MediaInfo> Media { get; } = new();
    public Dictionary<string, string> Embedded { get; } = new();
    private int _probes;
    public int Probes => _probes;

    /// <summary>Looked up by full path first, then by file name.</summary>
    public Task<MediaInfo?> ProbeAsync(string path, CancellationToken ct)
    {
        Interlocked.Increment(ref _probes);
        return Task.FromResult(Media.TryGetValue(path, out var full) ? full : Media.TryGetValue(Path.GetFileName(path), out var m) ? m : null);
    }

    public Task<string?> ExtractSubtitleAsync(string path, int i, CancellationToken ct) =>
        Task.FromResult(Embedded.TryGetValue(Path.GetFileName(path), out var s) ? s : null);

    public byte[]? Frame { get; set; }
    public int FrameGrabs { get; private set; }

    public Task<byte[]?> GrabFrameAsync(string path, double at, CancellationToken ct)
    {
        FrameGrabs++;
        return Task.FromResult(Frame);
    }
}

internal static class SongTitleTests
{
    private static SongGuess First(string title, string? author) => SongTitle.Guess(title, author)[0];

    [Test]
    public static void ReadsArtistAndSong()
    {
        Assert.Equal(new SongGuess("Peter Schilling", "Major Tom (Coming Home)"),
            First("Peter Schilling - Major Tom (Coming Home) (Official Video)", "Peter Schilling"));
        Assert.Equal("I Can't Tell You Why", First("Eagles - I Can't Tell You Why (Official Video) [HD]", "Eagles").Track);
        Assert.Equal("Kickstart My Heart", First("Motley Crue - Kickstart My Heart (Official HD Remaster)", "x").Track);
        Assert.Equal("Simple Minds", First("Don't You (Forget About Me) (Official Video)", "SimpleMindsVEVO").Artist);
        Assert.Equal("Peter Schilling", First("Major Tom", "Peter Schilling - Topic").Artist);
    }

    [Test]
    public static void HandlesCurlyQuotesAndDashTails()
    {
        Assert.Equal("Don't Look Back In Anger", First("Oasis - Don’t Look Back In Anger", "Oasis").Track);
        Assert.Equal("Live Is Life", First("OPUS - Live Is Life - Original Video 1985", "OPUS").Track);
        Assert.Equal("Live Is Life", First("OPUS - Live Is Life", "OPUS").Track); // "Live" in the name itself stays
        Assert.Equal("Song", First("Band - Song - Remastered 2011", "Band").Track);
    }

    [Test]
    public static void TitleFromDownloadedFileName()
    {
        Assert.Equal("Divinyls - I Touch Myself (Official Music Video)",
            SubtitleScanner.TitleFromFileName(Path.Combine("nas", "My MTV", "2009-03-05 - Divinyls - I Touch Myself (Official Music Video) [wv-34w8kGPM].mkv")));
    }
}

internal static class SubtitleTextTests
{
    [Test]
    public static void LrcToCuesAndSrt()
    {
        var cues = SubtitleText.ParseLrc("[00:12.50] Ground control\n[00:16.00] Countdown\n[00:20.00]\n[01:02.10][02:30.00] Four three two one\n", 200);
        Assert.Equal(4, cues.Count);
        Assert.Equal(new Cue(12.5, 16, "Ground control"), cues[0]);
        Assert.Equal(20.0, cues[1].End);       // blank line ends it
        Assert.Equal(62.1 + 8, cues[2].End);   // held at most 8 s

        var srt = SubtitleText.ToSrt(cues);
        Assert.Contains("1\n00:00:12,500 --> 00:00:16,000\nGround control\n", srt);
        var back = SubtitleText.ParseSrt(srt);
        Assert.Equal(cues.Count, back.Count);
        Assert.Equal(cues[3].Text, back[3].Text);
    }

    [Test]
    public static void SpotsBadSubtitles()
    {
        Cue C(double s, double e) => new(s, e, "x");
        Assert.Equal(null, SubtitleText.Problem([C(5, 8), C(60, 65), C(200, 210)], 240));
        Assert.Equal("empty", SubtitleText.Problem([], 240));
        Assert.Equal("almost empty", SubtitleText.Problem([C(1, 2)], 240));
        Assert.Contains("runs past the end", SubtitleText.Problem([C(5, 8), C(60, 65), C(300, 310)], 240)!);
        Assert.Contains("covers only the start", SubtitleText.Problem([C(5, 8), C(10, 12), C(20, 25)], 240)!);
    }
}

internal static class LyricsFinderTests
{
    private const string Lrc = "[00:12.50] Ground control\\n[00:16.00] Countdown\\n[00:20.00] Engines on\\n[02:00.00] Far above the moon";

    private static string Result(int id, double duration) =>
        $$"""{"id":{{id}},"trackName":"Major Tom","artistName":"Peter Schilling","duration":{{duration}},"instrumental":false,"syncedLyrics":"{{Lrc}}"}""";

    [Test]
    public static async Task PicksClosestLengthWithinThreeSeconds()
    {
        var http = new FakeHttp(_ => FakeHttp.Json($"[{Result(1, 280)},{Result(2, 301.5)},{Result(3, 299.2)}]"));
        var finder = new LyricsFinder(new HttpClient(http), null);
        var r = await finder.FindAsync("Peter Schilling - Major Tom (Coming Home) (Official Video)", null, 300, [], CancellationToken.None);
        Assert.Equal("lrclib:3", r.Result!.Id);
        Assert.Equal("LRCLIB", r.Result.Source);
        Assert.Equal("https://lrclib.net/api/search?artist_name=Peter%20Schilling&track_name=Major%20Tom%20%28Coming%20Home%29", http.Urls[0]);
    }

    [Test]
    public static async Task SkipsRejectedAndMismatchedLengths()
    {
        var http = new FakeHttp(_ => FakeHttp.Json($"[{Result(1, 300)},{Result(2, 280)}]"));
        var r = await new LyricsFinder(new HttpClient(http), null).FindAsync("A - B", null, 300, ["lrclib:1"], CancellationToken.None);
        Assert.Equal(null, r.Result);
        Assert.False(r.Retryable);
    }

    [Test]
    public static async Task SiteDownIsRetryable()
    {
        var r = await new LyricsFinder(new HttpClient(new FakeHttp(_ => FakeHttp.Json("bad gateway", HttpStatusCode.BadGateway))), null)
            .FindAsync("A - B", null, 300, [], CancellationToken.None);
        Assert.Equal(null, r.Result);
        Assert.True(r.Retryable);
    }

    [Test]
    public static async Task OpenSubtitlesOnlyWithKeyAndMatchingTitle()
    {
        var srt = "1\n00:00:10,000 --> 00:00:12,000\nGround control\n\n2\n00:01:00,000 --> 00:01:02,000\nx\n\n3\n00:04:00,000 --> 00:04:05,000\nmoon\n";
        var keys = new List<string?>();
        var http = new FakeHttp(req =>
        {
            var url = req.RequestUri!.ToString();
            if (url.StartsWith("https://lrclib.net/")) return FakeHttp.Json("[]");
            if (url.StartsWith("https://api.opensubtitles.com/")) keys.Add(req.Headers.TryGetValues("Api-Key", out var v) ? v.First() : null);
            if (url.Contains("/subtitles?")) return FakeHttp.Json("""{"data":[{"attributes":{"feature_details":{"title":"Major Tom (Coming Home)"},"files":[{"file_id":42}]}}]}""");
            if (url.EndsWith("/download")) return FakeHttp.Json("""{"link":"https://dl.opensubtitles.org/x.srt"}""");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(srt) };
        });

        var none = await new LyricsFinder(new HttpClient(http), "").FindAsync("Peter Schilling - Major Tom (Coming Home)", null, 300, [], CancellationToken.None);
        Assert.Equal(null, none.Result);
        Assert.True(http.Urls.All(u => u.StartsWith("https://lrclib.net/")));

        var hit = await new LyricsFinder(new HttpClient(http), "KEY").FindAsync("Peter Schilling - Major Tom (Coming Home)", null, 300, [], CancellationToken.None);
        Assert.Equal("os:42", hit.Result!.Id);
        Assert.Equal(2, keys.Count);              // search + download link request
        Assert.True(keys.All(k => k == "KEY"));   // the key goes to the API only, not to the file host
    }
}

internal static class BadSubsListTests
{
    [Test]
    public static void ReadsLinksIdsAndFileNamesAndCountsRepeats()
    {
        var dir = Path.Combine(TestEnv.Root, "badlist-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(dir);
        File.WriteAllText(BadSubsList.PathIn(dir), """
            # comment
            https://www.youtube.com/watch?v=wv-34w8kGPM&list=PL1
            https://youtu.be/CdqoNKCCt7A?t=10   # wrong timing
            2009-03-05 - Divinyls - I Touch Myself [wv-34w8kGPM].mkv
            k0WHSYFY21w
            not an id
            """);
        var counts = BadSubsList.Read(dir);
        Assert.Equal(2, counts["wv-34w8kGPM"]);
        Assert.Equal(1, counts["CdqoNKCCt7A"]);
        Assert.Equal(1, counts["k0WHSYFY21w"]);
        Assert.Equal(3, counts.Count);
    }

    [Test]
    public static void AddCreatesFileWithInstructionsThenAppends()
    {
        var dir = Path.Combine(TestEnv.Root, "badlist-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(dir);
        Assert.Equal("wv-34w8kGPM", BadSubsList.Add(dir, "https://www.youtube.com/watch?v=wv-34w8kGPM"));
        Assert.Equal(null, BadSubsList.Add(dir, "hello"));
        BadSubsList.Add(dir, "wv-34w8kGPM", "still wrong");
        var text = File.ReadAllText(BadSubsList.PathIn(dir));
        Assert.Contains("# YoutubeHDx: videos whose subtitles are wrong", text);
        Assert.Equal(2, BadSubsList.Read(dir)["wv-34w8kGPM"]);
    }
}

internal static class SubtitleScannerTests
{
    private const string Lrc = "[00:12.50] Ground control\\n[00:16.00] Countdown\\n[00:20.00] Engines on\\n[02:00.00] Far above the moon";
    private const string GoodSrt = "1\n00:00:05,000 --> 00:00:08,000\na\n\n2\n00:01:00,000 --> 00:01:05,000\nb\n\n3\n00:03:20,000 --> 00:03:30,000\nc\n";

    private sealed record Env(string Nas, FakeProbe Probe, FakeHttp Http, SubtitleScanner Scanner, List<string> Log)
    {
        public bool Paused { get; set; }
    }

    private static Env Make(Func<HttpRequestMessage, HttpResponseMessage>? lrclib = null, DateTimeOffset? now = null)
    {
        var settings = TestEnv.UseFakeYtDlp("ok");
        var nas = Path.Combine(TestEnv.Root, "scan-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(Path.Combine(nas, "My MTV"));
        settings.NasPath = nas;
        SettingsStore.Save(settings);
        if (File.Exists(AppPaths.SubtitleStateFile)) File.Delete(AppPaths.SubtitleStateFile);

        var probe = new FakeProbe();
        var http = new FakeHttp(lrclib ?? (_ => FakeHttp.Json(
            $$"""[{"id":7,"trackName":"Major Tom","artistName":"Peter Schilling","duration":240.5,"instrumental":false,"syncedLyrics":"{{Lrc}}"}]""")));
        var log = new List<string>();
        Env? env = null;
        var scanner = new SubtitleScanner(SettingsStore.Load, probe, s => new LyricsFinder(new HttpClient(http), s.OpenSubtitlesApiKey),
            () => env!.Paused, m => { lock (log) log.Add(m); }, now is null ? null : () => now.Value, TimeSpan.Zero);
        env = new Env(nas, probe, http, scanner, log);
        return env;
    }

    private static string Video(Env env, string name, double duration = 240, string? title = null)
    {
        var path = Path.Combine(env.Nas, "My MTV", name);
        File.WriteAllText(path, "fake video");
        env.Probe.Media[name] = new MediaInfo(duration, title, null, []);
        return path;
    }

    private const string MajorTom = "2020-02-14 - Peter Schilling - Major Tom (Coming Home) (Official Video) [wO0A0XcWy88].mkv";

    [Test]
    public static async Task AddsLyricsSidecarWhenThereAreNoSubtitles()
    {
        var env = Make();
        var video = Video(env, MajorTom);

        var summary = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(1, summary.Fixed);

        var srt = Path.ChangeExtension(video, ".en.srt");
        Assert.True(File.Exists(srt));
        Assert.Contains("Ground control", File.ReadAllText(srt));
        Assert.Contains("artist_name=Peter%20Schilling", env.Http.Urls[0]);
    }

    [Test]
    public static async Task SecondScanSkipsUnchangedFiles()
    {
        var env = Make();
        Video(env, MajorTom);
        await env.Scanner.ScanAllAsync(CancellationToken.None);
        var probes = env.Probe.Probes;
        var lookups = env.Http.Urls.Count;

        var again = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(0, again.Checked);
        Assert.Equal(probes, env.Probe.Probes);    // not even ffprobe
        Assert.Equal(lookups, env.Http.Urls.Count);
    }

    [Test]
    public static async Task LeavesGoodSubtitlesAlone()
    {
        var env = Make();
        var video = Video(env, "2010-12-03 - Simple Minds - Don't You [CdqoNKCCt7A].mkv", 263);
        File.WriteAllText(Path.ChangeExtension(video, ".en-nP7-2PuUl7o.srt"), GoodSrt);

        var summary = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(1, summary.AlreadyGood);
        Assert.Equal(0, env.Http.Urls.Count);
        Assert.Equal(1, Directory.GetFiles(Path.GetDirectoryName(video)!, "*.srt").Length);
    }

    [Test]
    public static async Task ReplacesBadSubtitlesWithoutTouchingTheOldFile()
    {
        var env = Make();
        var video = Video(env, MajorTom);
        var bad = Path.ChangeExtension(video, ".en.srt");
        File.WriteAllText(bad, "1\n00:00:01,000 --> 00:00:02,000\nhi\n");  // almost empty
        var before = File.ReadAllText(bad);

        var summary = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(1, summary.Fixed);
        Assert.Equal(before, File.ReadAllText(bad));                          // never edited
        Assert.Contains("Ground control", File.ReadAllText(Path.ChangeExtension(video, ".en.lyrics.srt")));
    }

    [Test]
    public static async Task ReadsEmbeddedSubtitlesWhenThereIsNoSidecar()
    {
        var env = Make();
        var name = "2010-12-03 - Simple Minds - Don't You [CdqoNKCCt7A].mkv";
        Video(env, name, 263);
        env.Probe.Media[name] = new MediaInfo(263, null, null, [new SubtitleStream(0, "eng")]);
        env.Probe.Embedded[name] = GoodSrt;

        var summary = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(1, summary.AlreadyGood);
        Assert.Equal(0, env.Http.Urls.Count);
    }

    [Test]
    public static async Task BadListTriggersAnotherSourceEachTime()
    {
        var calls = 0;
        var env = Make(req =>
        {
            calls++;
            // id 7 first; once 7 is rejected the finder must ask again and gets 8
            return FakeHttp.Json($$"""
                [{"id":7,"trackName":"Major Tom","artistName":"Peter Schilling","duration":240.5,"instrumental":false,"syncedLyrics":"{{Lrc}}"},
                 {"id":8,"trackName":"Major Tom","artistName":"Peter Schilling","duration":241.5,"instrumental":false,"syncedLyrics":"{{Lrc.Replace("Ground control", "Second version")}}"}]
                """);
        });
        var video = Video(env, MajorTom);
        await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.True(File.Exists(Path.ChangeExtension(video, ".en.srt")));

        // You flag it: our lyrics (lrclib:7) are rejected and the next match is added under a new name.
        BadSubsList.Add(env.Nas, "https://youtu.be/wO0A0XcWy88");
        var s2 = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(1, s2.Fixed);
        Assert.Contains("Second version", File.ReadAllText(Path.ChangeExtension(video, ".en.lyrics.srt")));

        // Nothing new flagged: left alone.
        var s3 = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(0, s3.Checked);

        // Flagged again: both 7 and 8 rejected, nothing else within 3 s -> no new file.
        BadSubsList.Add(env.Nas, "wO0A0XcWy88");
        var s4 = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(1, s4.NotFound);
        Assert.False(File.Exists(Path.ChangeExtension(video, ".en.lyrics2.srt")));
    }

    [Test]
    public static async Task NotFoundIsRetriedAfterAWeekAndSiteDownAfterAnHour()
    {
        var now = DateTimeOffset.Parse("2026-11-02T12:00:00Z");
        var down = true;
        var env = Make(_ => down ? FakeHttp.Json("x", HttpStatusCode.BadGateway) : FakeHttp.Json("[]"), now);
        Video(env, MajorTom);

        Assert.Equal(1, (await env.Scanner.ScanAllAsync(CancellationToken.None)).NotFound);
        var s2 = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(0, s2.Checked); // within the hour

        var later = Make(_ => FakeHttp.Json("[]"), now.AddHours(2));
        // (new scanner with a later clock, same state file)
        File.Copy(Path.Combine(env.Nas, "My MTV", MajorTom), Path.Combine(later.Nas, "My MTV", MajorTom));
        later.Probe.Media[MajorTom] = env.Probe.Media[MajorTom];
        down = false;
        Assert.Equal(1, (await later.Scanner.ScanAllAsync(CancellationToken.None)).NotFound);
    }

    [Test]
    public static async Task StopsWhenDownloadsArePaused()
    {
        var env = Make();
        Video(env, MajorTom);
        env.Paused = true;
        var summary = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.True(summary.Stopped);
        Assert.Equal(0, env.Http.Urls.Count);
        Assert.Equal(0, env.Probe.Probes);
    }

    [Test]
    public static async Task IgnoresFilesThatAreNotOurDownloads()
    {
        var env = Make();
        File.WriteAllText(Path.Combine(env.Nas, "My MTV", "Some other video.mkv"), "x");
        var summary = await env.Scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(0, summary.Checked);
        Assert.Equal(0, env.Probe.Probes);
    }

    [Test]
    public static async Task SingleFileScanAfterDownload()
    {
        var env = Make();
        var video = Video(env, MajorTom);
        Assert.Equal(ScanOutcome.Fixed, await env.Scanner.ScanFileAsync(video, CancellationToken.None));
        Assert.True(File.Exists(Path.ChangeExtension(video, ".en.srt")));
    }
}

internal static class UnavailableTests
{
    [Test]
    public static void ClassifiesRealLossesOnly()
    {
        UnavailableVideo? P(string reason) => UnavailableVideos.Parse($"ERROR: [youtube] abcdefghijk: {reason}");
        Assert.Equal("removed", P("Video unavailable. This video has been removed by the uploader")!.Category);
        Assert.Equal("private", P("Private video. Sign in if you've been granted access to this video")!.Category);
        Assert.Equal("blocked in your country", P("Video unavailable. The uploader has not made this video available in your country")!.Category);
        Assert.Equal("copyright", P("Video unavailable. This video contains content from SME, who has blocked it in your country on copyright grounds")!.Category);
        Assert.Equal("members only", P("Join this channel to get access to members-only content like this video")!.Category);
        Assert.Equal("removed", P("Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.")!.Category);
        // temporary problems are not losses
        Assert.Equal(null, P("Sign in to confirm you're not a bot"));
        Assert.Equal(null, P("HTTP Error 403: Forbidden"));
        Assert.Equal(null, UnavailableVideos.Parse("WARNING: something"));
    }

    [Test]
    public static async Task PlaylistJobWritesCsvRowsOnceWithTitles()
    {
        var s = TestEnv.UseFakeYtDlp("playlist-unavailable");
        var nas = Path.Combine(TestEnv.Root, "csv-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(nas);
        s.NasPath = nas;
        SettingsStore.Save(s);
        if (File.Exists(AppPaths.UnavailableStateFile)) File.Delete(AppPaths.UnavailableStateFile);

        await using var queue = new DownloadQueue(_ => { });
        queue.Reporter = new UnavailableReporter(SettingsStore.Load, null, _ => { }, () => DateTimeOffset.Parse("2026-11-02T12:00:00-05:00"));
        var done = new TaskCompletionSource<DownloadJob>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.JobFinished += j => done.TrySetResult(j);
        queue.Start(1);
        queue.Enqueue("https://www.youtube.com/playlist?list=PLx", noPlaylist: false, source: "test");
        var job = await done.Task.WaitAsync(TimeSpan.FromSeconds(20));

        Assert.Equal(2, job.Unavailable.Count);
        var csv = File.ReadAllText(Path.Combine(nas, UnavailableReporter.CsvName));
        var lines = csv.TrimStart('\uFEFF').Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("first_seen,video_id,youtube_link,title,channel,playlist,reason,details", lines[0]);
        Assert.Equal(3, lines.Length);
        Assert.Contains("gone0000001,https://www.youtube.com/watch?v=gone0000001,\"Song, With Comma\",Some Band,My MTV,copyright,", csv);
        Assert.Contains("gone0000002,https://www.youtube.com/watch?v=gone0000002,,,My MTV,removed,", csv); // "[Deleted video]" title dropped

        // Next sync hits the same videos: nothing is listed twice.
        var again = new TaskCompletionSource<DownloadJob>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.JobFinished += j => again.TrySetResult(j);
        queue.Enqueue("https://www.youtube.com/playlist?list=PLx", noPlaylist: false, source: "test");
        await again.Task.WaitAsync(TimeSpan.FromSeconds(20));
        var lines2 = File.ReadAllText(Path.Combine(nas, UnavailableReporter.CsvName)).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(3, lines2.Length);
    }

    [Test]
    public static async Task FileSavedEventFiresForEachDownload()
    {
        TestEnv.UseFakeYtDlp("ok");
        await using var queue = new DownloadQueue(_ => { });
        var saved = new List<string>();
        queue.FileSaved += (f, _) => { lock (saved) saved.Add(f); };
        var done = new TaskCompletionSource<DownloadJob>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.JobFinished += j => done.TrySetResult(j);
        queue.Start(1);
        queue.Enqueue("https://www.youtube.com/watch?v=vid1", true, "test");
        await done.Task.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(1, saved.Count);
        Assert.True(saved[0].EndsWith("First Video [vid1].mkv"));
    }
}
