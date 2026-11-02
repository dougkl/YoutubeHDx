using YoutubeHDx.Core;

namespace YoutubeHDx.Tests;

/// <summary>Runs the real queue + runner against a fake yt-dlp script.</summary>
internal static class QueueTests
{
    private static async Task<(DownloadQueue Queue, Task<DownloadJob> Finished)> StartQueue()
    {
        var queue = new DownloadQueue(_ => { });
        var finished = new TaskCompletionSource<DownloadJob>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.JobFinished += j => finished.TrySetResult(j);
        queue.Start(1);
        await Task.Yield();
        return (queue, finished.Task);
    }

    [Test]
    public static async Task SuccessfulDownloadParsesTitleProgressAndFile()
    {
        TestEnv.UseFakeYtDlp("ok");
        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/watch?v=vid1", noPlaylist: true, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.Completed, s.Status);
        Assert.Equal("First Video", s.Title);
        Assert.Equal("My MTV", s.PlaylistTitle);            // shown in the downloads window
        Assert.True(s.UpdatedAt >= s.CreatedAt);
        Assert.Equal(1, s.ItemsCompleted);
        Assert.Equal(100.0, s.Percent);
        Assert.True(s.LastFile!.EndsWith("First Video [vid1].mkv"));
        Assert.Equal(null, s.Error);

        var args = TestEnv.ReadFakeArgs();
        Assert.Contains("--no-playlist", args);
        Assert.Contains("--no-write-auto-subs", args);
        Assert.Contains("https://www.youtube.com/watch?v=vid1", args);
        // Characters a shell would mangle (<, >, |, %, *) must arrive intact.
        Assert.Contains("bv*[height<=2160]+ba/b[height<=2160]/bv*+ba/b", args);
        Assert.Contains("%(upload_date>%Y-%m-%d)s", args);
    }

    [Test]
    public static async Task PlaylistWithOneBadVideoIsCompletedWithErrors()
    {
        TestEnv.UseFakeYtDlp("playlist-partial");
        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/playlist?list=PL1", noPlaylist: false, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.CompletedWithErrors, s.Status);
        Assert.Equal(1, s.ItemsCompleted);
        Assert.Contains("Video unavailable", s.Error!);
        Assert.Contains("--yes-playlist", TestEnv.ReadFakeArgs());
    }

    [Test]
    public static async Task FailureSurfacesYtDlpError()
    {
        TestEnv.UseFakeYtDlp("fail");
        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/watch?v=vid9", noPlaylist: true, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.Failed, s.Status);
        Assert.Contains("Sign in to confirm your age", s.Error!);
    }

    [Test]
    public static async Task MissingNasFailsWithClearMessage()
    {
        var settings = TestEnv.UseFakeYtDlp("ok");
        settings.NasPath = Path.Combine(TestEnv.Root, "does-not-exist");
        SettingsStore.Save(settings);

        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/watch?v=vid1", noPlaylist: true, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.Failed, s.Status);
        Assert.Contains("is not reachable", s.Error!);
    }

    [Test]
    public static async Task MissingYtDlpFailsWithInstallHint()
    {
        var settings = TestEnv.UseFakeYtDlp("ok");
        settings.YtDlpPath = Path.Combine(TestEnv.Root, "no-such-yt-dlp");
        SettingsStore.Save(settings);

        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/watch?v=vid1", noPlaylist: true, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.Failed, s.Status);
        Assert.Contains("winget install yt-dlp", s.Error!);
    }

    [Test]
    public static async Task RequireLoginRefusesAnonymousDownloads()
    {
        var settings = TestEnv.UseFakeYtDlp("ok");
        settings.RequireLogin = true;
        SettingsStore.Save(settings);
        if (File.Exists(AppPaths.CookiesFile)) File.Delete(AppPaths.CookiesFile);

        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/watch?v=vid1", noPlaylist: true, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.Failed, s.Status);
        Assert.Contains("Not signed in", s.Error!);
    }

    [Test]
    public static async Task RequireLoginAllowsSignedInDownloadsAndPassesCookies()
    {
        var settings = TestEnv.UseFakeYtDlp("ok");
        settings.RequireLogin = true;
        SettingsStore.Save(settings);
        CookieFile.WriteNetscape(AppPaths.CookiesFile,
            [new BrowserCookie(".youtube.com", false, "/", true, true, false, 1800000000, "LOGIN_INFO", "x")]);

        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        queue.Enqueue("https://www.youtube.com/watch?v=vid1", noPlaylist: true, source: "test");
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(15))).ToSnapshot();

        Assert.Equal(JobStatus.Completed, s.Status);
        Assert.Contains(AppPaths.CookiesFile, TestEnv.ReadFakeArgs());
        File.Delete(AppPaths.CookiesFile);
    }

    [Test]
    public static async Task CancelKillsRunningDownload()
    {
        TestEnv.UseFakeYtDlp("slow");
        var (queue, finished) = await StartQueue();
        await using var _ = queue;

        var (_, job) = queue.Enqueue("https://www.youtube.com/watch?v=slow", noPlaylist: true, source: "test");
        for (var i = 0; i < 50 && job.Status != JobStatus.Running; i++) await Task.Delay(100);
        await Task.Delay(300); // let the process start

        Assert.True(queue.Cancel(job.Id));
        var s = (await finished.WaitAsync(TimeSpan.FromSeconds(10))).ToSnapshot();
        Assert.Equal(JobStatus.Canceled, s.Status);
    }

    [Test]
    public static async Task CancelQueuedJobSkipsIt()
    {
        TestEnv.UseFakeYtDlp("slow");
        var queue = new DownloadQueue(_ => { });
        await using var _ = queue;
        var finished = new List<DownloadJob>();
        queue.JobFinished += j => { lock (finished) finished.Add(j); };
        queue.Start(1);

        var (_, running) = queue.Enqueue("https://www.youtube.com/watch?v=a1", true, "test");
        var (_, waiting) = queue.Enqueue("https://www.youtube.com/watch?v=a2", true, "test");
        for (var i = 0; i < 50 && running.Status != JobStatus.Running; i++) await Task.Delay(100);

        Assert.Equal(JobStatus.Queued, waiting.Status);
        Assert.True(queue.Cancel(waiting.Id));
        Assert.Equal(JobStatus.Canceled, waiting.Status);
        queue.Cancel(running.Id);
    }

    [Test]
    public static async Task ShutdownNeverStartsTheNextQueuedJob()
    {
        TestEnv.UseFakeYtDlp("slow");
        var logs = new List<string>();
        var queue = new DownloadQueue(m => { lock (logs) logs.Add(m); });
        queue.Start(1);

        var (_, running) = queue.Enqueue("https://www.youtube.com/playlist?list=PL1", false, "test");
        var (_, next) = queue.Enqueue("https://www.youtube.com/playlist?list=PL2", false, "test");
        for (var i = 0; i < 50 && running.Status != JobStatus.Running; i++) await Task.Delay(100);
        await Task.Delay(300);

        await queue.DisposeAsync();

        Assert.Equal(JobStatus.Canceled, running.Status);
        Assert.Equal(JobStatus.Queued, next.Status); // left for the next app start, never launched
        lock (logs)
        {
            Assert.False(logs.Any(l => l.Contains("Starting job " + next.Id)));
            Assert.True(logs.Any(l => l.Contains("shutting down")));
        }
    }

    [Test]
    public static async Task DuplicateUrlIsNotQueuedTwice()
    {
        TestEnv.UseFakeYtDlp("slow");
        var queue = new DownloadQueue(_ => { });
        await using var _ = queue;

        var first = queue.Enqueue("https://www.youtube.com/watch?v=dup", true, "test");
        var second = queue.Enqueue("https://www.youtube.com/watch?v=dup", true, "test");
        var asPlaylist = queue.Enqueue("https://www.youtube.com/watch?v=dup", false, "test");

        Assert.True(first.Added);
        Assert.False(second.Added);
        Assert.Equal(first.Job.Id, second.Job.Id);
        Assert.True(asPlaylist.Added); // different mode = different job
        Assert.Equal(2, queue.Snapshot().Count);
    }

    [Test]
    public static async Task RejectsNonHttpUrls()
    {
        var queue = new DownloadQueue(_ => { });
        await using var _ = queue;
        Assert.Throws<ArgumentException>(() => queue.Enqueue("not a url", true, "test"));
        Assert.Throws<ArgumentException>(() => queue.Enqueue("file:///etc/passwd", true, "test"));
    }

    [Test]
    public static async Task WatchSchedulerQueuesOnlyEnabledPlaylists()
    {
        var s = TestEnv.UseFakeYtDlp("slow");
        s.WatchedPlaylists =
        [
            new WatchedPlaylist { Url = "https://www.youtube.com/playlist?list=PLon" },
            new WatchedPlaylist { Url = "https://www.youtube.com/playlist?list=PLoff", Enabled = false },
            new WatchedPlaylist { Url = "" },
        ];
        SettingsStore.Save(s);

        var queue = new DownloadQueue(_ => { });
        await using var _ = queue;
        using var watcher = new WatchScheduler(queue, _ => { });

        Assert.Equal(1, watcher.SyncNow());
        Assert.Equal(0, watcher.SyncNow()); // already queued
        var job = queue.Snapshot().Single();
        Assert.Equal("https://www.youtube.com/playlist?list=PLon", job.Url);
        Assert.Equal("watch", job.Source);
    }
}
