using YoutubeHDx.Core;

namespace YoutubeHDx.Tests;

/// <summary>Pause/resume and crash recovery, against the real queue and the fake yt-dlp.</summary>
internal static class PauseTests
{
    private static async Task WaitFor(Func<bool> condition, int timeoutMs = 10_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new AssertException("Timed out waiting for condition");
            await Task.Delay(50);
        }
    }

    [Test]
    public static async Task PauseInterruptsDownloadAndResumeFinishesIt()
    {
        TestEnv.UseFakeYtDlp("slow-then-ok");
        var finished = new TaskCompletionSource<DownloadJob>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var queue = new DownloadQueue(_ => { });
        queue.JobFinished += j => finished.TrySetResult(j);
        queue.Start(1);

        var (_, job) = queue.Enqueue("https://www.youtube.com/watch?v=vid1", true, "test");
        await WaitFor(() => job.Status == JobStatus.Running && File.Exists(Path.Combine(TestEnv.Root, "args.txt.ran")));

        var state = queue.Pause(null);
        Assert.True(state.IsPaused);
        Assert.Equal(null, state.Until);
        await WaitFor(() => job.Status == JobStatus.Paused);

        await Task.Delay(700);
        Assert.Equal(JobStatus.Paused, job.Status); // stays paused, nothing restarts on its own
        Assert.False(finished.Task.IsCompleted);

        queue.Resume();
        var done = await finished.Task.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(JobStatus.Completed, done.Status);
        Assert.Equal(1, done.ItemsCompleted);
    }

    [Test]
    public static async Task NothingStartsWhilePaused()
    {
        TestEnv.UseFakeYtDlp("ok");
        await using var queue = new DownloadQueue(_ => { });
        queue.Pause(TimeSpan.FromHours(1));
        queue.Start(1);

        var (_, job) = queue.Enqueue("https://www.youtube.com/watch?v=vid1", true, "test");
        await Task.Delay(800);
        Assert.Equal(JobStatus.Queued, job.Status);
        Assert.False(File.Exists(Path.Combine(TestEnv.Root, "args.txt"))); // yt-dlp never launched
        queue.Resume();
        await WaitFor(() => job.Status == JobStatus.Completed);
    }

    [Test]
    public static async Task TimedPauseResumesByItself()
    {
        TestEnv.UseFakeYtDlp("ok");
        var changes = new List<PauseState>();
        await using var queue = new DownloadQueue(_ => { });
        queue.PauseChanged += s => { lock (changes) changes.Add(s); };
        queue.Pause(TimeSpan.FromMilliseconds(600));
        queue.Start(1);

        var (_, job) = queue.Enqueue("https://www.youtube.com/watch?v=vid1", true, "test");
        Assert.True(queue.PauseState.IsPaused);
        Assert.True(queue.PauseState.Until is not null);

        await WaitFor(() => job.Status == JobStatus.Completed, 8000);
        Assert.False(queue.PauseState.IsPaused);
        lock (changes) Assert.True(changes.Count == 2 && changes[0].IsPaused && !changes[1].IsPaused);
    }

    [Test]
    public static async Task PauseSurvivesRestart()
    {
        await using (var q1 = new DownloadQueue(_ => { })) q1.Pause(TimeSpan.FromHours(2));

        await using var q2 = new DownloadQueue(_ => { });
        Assert.True(q2.PauseState.IsPaused);
        Assert.True(q2.PauseState.Until > DateTimeOffset.Now.AddMinutes(110));
        q2.Resume();

        await using var q3 = new DownloadQueue(_ => { });
        Assert.False(q3.PauseState.IsPaused);
    }

    [Test]
    public static async Task ExpiredPauseIsIgnoredAfterRestart()
    {
        await using (var q1 = new DownloadQueue(_ => { })) q1.Pause(TimeSpan.FromMilliseconds(100));
        await Task.Delay(300);
        await using var q2 = new DownloadQueue(_ => { });
        Assert.False(q2.PauseState.IsPaused);
    }

    [Test]
    public static async Task CancelWorksOnPausedJob()
    {
        TestEnv.UseFakeYtDlp("slow");
        await using var queue = new DownloadQueue(_ => { });
        queue.Start(1);
        var (_, job) = queue.Enqueue("https://www.youtube.com/watch?v=slow", true, "test");
        await WaitFor(() => job.Status == JobStatus.Running);
        await Task.Delay(300);

        queue.Pause(null);
        await WaitFor(() => job.Status == JobStatus.Paused);
        Assert.True(queue.Cancel(job.Id));
        Assert.Equal(JobStatus.Canceled, job.Status);
        queue.Resume();
        await Task.Delay(500);
        Assert.Equal(JobStatus.Canceled, job.Status); // not resurrected by the resume
    }

    [Test]
    public static async Task UserCancelIsNotMistakenForPause()
    {
        TestEnv.UseFakeYtDlp("slow");
        await using var queue = new DownloadQueue(_ => { });
        queue.Start(1);
        var (_, job) = queue.Enqueue("https://www.youtube.com/watch?v=slow", true, "test");
        await WaitFor(() => job.Status == JobStatus.Running);
        await Task.Delay(300);

        queue.Cancel(job.Id);
        await WaitFor(() => job.Status == JobStatus.Canceled);
        Assert.False(queue.PauseState.IsPaused);
    }

    [Test]
    public static async Task UnfinishedJobsComeBackAfterACrash()
    {
        TestEnv.UseFakeYtDlp("ok");
        // "Crash": jobs queued, app never shuts down cleanly (no Start, no Dispose).
        var crashed = new DownloadQueue(_ => { });
        crashed.Pause(null); // so nothing runs before the "crash"
        crashed.Enqueue("https://www.youtube.com/watch?v=one", true, "extension");
        crashed.Enqueue("https://www.youtube.com/playlist?list=PL2", false, "extension");

        var logs = new List<string>();
        await using var restarted = new DownloadQueue(m => { lock (logs) logs.Add(m); });
        var jobs = restarted.Snapshot();
        Assert.Equal(2, jobs.Count);
        Assert.True(jobs.Any(j => j.Url.EndsWith("v=one")));
        Assert.True(jobs.Any(j => j.Url.EndsWith("list=PL2")));
        Assert.True(restarted.PauseState.IsPaused); // the pause came back too
        lock (logs) Assert.True(logs.Any(l => l.Contains("Restoring 2 unfinished job(s)")));

        restarted.Resume();
        restarted.Start(1);
        await WaitFor(() => restarted.Snapshot().All(j => j.Status == JobStatus.Completed));

        await using var third = new DownloadQueue(_ => { });
        Assert.Equal(0, third.Snapshot().Count); // finished jobs are not restored again
    }

    [Test]
    public static async Task JobStoppedByShutdownRunsAgainAfterRestart()
    {
        TestEnv.UseFakeYtDlp("slow");
        var q1 = new DownloadQueue(_ => { });
        q1.Start(1);
        var (_, job) = q1.Enqueue("https://www.youtube.com/watch?v=long", true, "extension");
        await WaitFor(() => job.Status == JobStatus.Running);
        await Task.Delay(300);
        await q1.DisposeAsync();

        await using var q2 = new DownloadQueue(_ => { });
        Assert.Equal("https://www.youtube.com/watch?v=long", q2.Snapshot().Single().Url);
    }

    [Test]
    public static void PauseRejectsNonPositiveDurations()
    {
        var queue = new DownloadQueue(_ => { });
        Assert.Throws<ArgumentOutOfRangeException>(() => queue.Pause(TimeSpan.Zero));
    }

    [Test]
    public static void DescribeIsFriendly()
    {
        Assert.Equal("Downloading", PauseState.Running.Describe());
        Assert.Equal("Paused until you resume", new PauseState(true, null).Describe());
        Assert.True(new PauseState(true, DateTimeOffset.Now.AddHours(1)).Describe().StartsWith("Paused until "));
    }
}
