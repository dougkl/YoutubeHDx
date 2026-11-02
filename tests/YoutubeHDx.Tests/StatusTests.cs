using YoutubeHDx.Core;
using YoutubeHDx.Core.Lyrics;
using YoutubeHDx.Core.Subtitles;

namespace YoutubeHDx.Tests;

internal static class StatusTests
{
    [Test]
    public static void FriendlyErrorsSayWhatToDo()
    {
        Assert.Contains("updating yt-dlp", FriendlyError.Describe("ERROR: [youtube] abcdefghijk: HTTP Error 403: Forbidden"));
        Assert.Contains("click the YoutubeHDx extension icon", FriendlyError.Describe("ERROR: [youtube] abcdefghijk: Sign in to confirm you’re not a bot"));
        Assert.Contains("network problem", FriendlyError.Describe("ERROR: [youtube] abcdefghijk: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>"));
        Assert.Equal("Something odd happened", FriendlyError.Describe("ERROR: [youtube] abcdefghijk: Something odd happened"));
        Assert.Contains("see the log", FriendlyError.Describe(null));
    }

    [Test]
    public static void JobShowsSubtitleResultsOfItsVideos()
    {
        var job = new DownloadJob { Url = "https://www.youtube.com/playlist?list=PL1" };
        Assert.Equal(null, job.ToSnapshot().Subtitles);
        job.AddSubtitleOutcome(ScanOutcome.Good);
        job.AddSubtitleOutcome(ScanOutcome.Good);
        job.AddSubtitleOutcome(ScanOutcome.Fixed);
        job.AddSubtitleOutcome(ScanOutcome.NotFound);
        job.AddSubtitleOutcome(ScanOutcome.Paused); // not a result yet
        Assert.Equal("2 OK, 1 lyrics added, 1 none found", job.ToSnapshot().Subtitles);
    }

    [Test]
    public static void WaitingPlaylistSaysItIsChecking()
    {
        var job = new DownloadJob { Url = "https://www.youtube.com/playlist?list=PL1", DisplayName = "Rock" };
        var s = job.ToSnapshot();
        Assert.Equal("Rock", s.Name);
        Assert.Equal("Waiting", s.StatusText);
        Assert.Equal("Waiting for its turn", s.Summary);
        Assert.True(s.IsPlaylist);
    }

    [Test]
    public static async Task SubtitleCheckShowsProgressAndResultOnTheBoard()
    {
        var settings = TestEnv.UseFakeYtDlp("ok");
        var nas = Path.Combine(TestEnv.Root, "board-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(nas);
        settings.NasPath = nas;
        SettingsStore.Save(settings);
        if (File.Exists(AppPaths.SubtitleStateFile)) File.Delete(AppPaths.SubtitleStateFile);
        File.WriteAllText(Path.Combine(nas, "Song [abcdefghijk].mkv"), "x");

        var probe = new FakeProbe();
        probe.Media["Song [abcdefghijk].mkv"] = new MediaInfo(240, "Band - Song", null, []);
        var board = new ActivityBoard();
        var seen = new List<ActivitySnapshot>();
        var http = new FakeHttp(_ =>
        {
            seen.Add(board.Get(SubtitleScanner.ActivityKey)!); // what the window shows while it works
            return FakeHttp.Json("[]");
        });
        var scanner = new SubtitleScanner(SettingsStore.Load, probe, s => new LyricsFinder(new HttpClient(http), ""),
            () => false, _ => { }, null, TimeSpan.Zero) { Board = board };

        await scanner.ScanAllAsync(CancellationToken.None);

        Assert.True(seen.Count > 0);
        Assert.True(seen[0].Running);
        Assert.Equal("Checking 1 of 1", seen[0].StatusText);
        Assert.Equal("Song [abcdefghijk]", seen[0].Current);
        var after = board.Get(SubtitleScanner.ActivityKey)!;
        Assert.False(after.Running);
        Assert.Equal("Idle", after.StatusText);
        Assert.Contains("1 videos, 1 checked", after.Summary!);
    }
}
