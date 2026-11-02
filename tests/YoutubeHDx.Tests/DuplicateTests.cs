using YoutubeHDx.Core;
using YoutubeHDx.Core.Library;
using YoutubeHDx.Core.Subtitles;

namespace YoutubeHDx.Tests;

internal static class SongKeyTests
{
    private static SongMatch M(string a, double da, string b, double db) =>
        SongKey.Compare(SongKey.Parse(a), da, SongKey.Parse(b), db).Match;

    [Test]
    public static void SameSongDifferentNoise()
    {
        Assert.Equal(SongMatch.Same, M("Aqua - Barbie Girl", 197, "Aqua - Barbie Girl (Official Music Video)", 198));
        Assert.Equal(SongMatch.Same, M("Pink Floyd - Comfortably Numb [HD]", 382, "Pink Floyd   Comfortably Numb  (Official Vídeo High Quality)", 383));
        Assert.Equal(SongMatch.Same, M("Fatboy Slim ft. Bootsy Collins - Weapon Of Choice [Official Video]", 210, "Fatboy Slim - Weapon Of Choice [Official Video]", 211));
        Assert.Equal(SongMatch.Same, M("Lenny Kravitz - It Ain't Over 'Til It's Over", 240, "Lenny Kravitz - It Ain’t Over Til It's Over (Official Music Video)", 242));
        Assert.Equal(SongMatch.Same, M("Pharrell Williams-Happy (Official)", 233, "Pharrell Williams - Happy", 233));
        Assert.Equal(SongMatch.Same, M("Oh, Pretty Woman - Roy Orbison", 175, "Roy Orbison - Oh, Pretty Woman (Official Video)", 176)); // reversed
        Assert.Equal(SongMatch.Same, M("Daryl Hall & John Oates - Maneater", 270, "Daryl Hall and John Oates - Maneater (Official Video)", 271));
        Assert.Equal(SongMatch.Same, M("Pet Shop Boys - It's A Sin (Official Video) [HD REMASTERED]", 300, "The Pet Shop Boys - It's A Sin", 300));
    }

    [Test]
    public static void DifferentVersionsAreNeverTheSameSong()
    {
        Assert.Equal(SongMatch.Different, M("The Beatles - Let It Be", 243, "The Beatles - Let It Be (Live)", 243));
        Assert.Equal(SongMatch.Different, M("Cinderella - Don't Know What You Got (Till It's Gone) [Official Video]", 300,
                                            "Cinderella - Don't Know What You Got (Till It's Gone) (Stereo Version)", 300));
        Assert.Equal(SongMatch.Different, M("The Beatles - Here Comes The Sun", 185, "The Beatles - Here Comes The Sun (2019 Mix)", 185));
        Assert.Equal(SongMatch.Different, M("Def Leppard - Hysteria", 355, "Def Leppard - Hysteria (Long Version)", 355));
        Assert.Equal(SongMatch.Different, M("ZZ Top - Gimme All Your Lovin' (Official Music Video)", 240, "ZZ Top - Gimme All Your Lovin' (Live)", 241));
        Assert.Equal(SongMatch.Different, M("Keane - Everybody's Changing", 215, "Keane - Everybody's Changing (Alternate Version)", 215));
        Assert.Equal(SongMatch.Different, M("Chris Cornell - Black Hole Sun Acoustic", 300, "Chris Cornell - Black Hole Sun", 300));
        Assert.Equal(SongMatch.Different, M("Moon River - CLARA (Cover)", 180, "Audrey Hepburn - Moon River", 180));
        Assert.Equal(SongMatch.Different, M("OPUS - Live Is Life", 250, "OPUS - Live Is Life (Live)", 250)); // "Live" in the name counts once
        Assert.Equal(SongMatch.Same, M("OPUS - Live Is Life - Original Video 1985", 250, "OPUS - Live Is Life", 251));
        Assert.Equal(SongMatch.Different, M("Billy Idol - White Wedding Pt 1 (Official Music Video)", 250, "Billy Idol - White Wedding", 250));
        Assert.Equal(SongMatch.Different, M("Scorpions, Berliner Philharmoniker - Wind Of Change", 300, "Scorpions - Wind Of Change", 300));
    }

    [Test]
    public static void LengthDecides()
    {
        Assert.Equal(SongMatch.Unsure, M("Journey - Faithfully", 260, "Journey - Faithfully (Official Video)", 275));   // another cut?
        Assert.Equal(SongMatch.Different, M("Bruce Springsteen - Born to Run", 270, "Bruce Springsteen - Born to Run", 330)); // way off
        Assert.Equal(SongMatch.Unsure, M("Bruce Springsteen - Born to Run", 270, "Bruce Springsteen - Born to Run", 0));     // unknown
    }

    [Test]
    public static void UnsureCasesAreLeftToYou()
    {
        Assert.Equal(SongMatch.Unsure, M("Heart - Barracuda", 262, "barracuda", 262));                                        // no artist
        Assert.Equal(SongMatch.Unsure, M("Alice DJ - Better Off Alone (Official Video)", 214, "Alice Deejay - Better Off Alone (Official Video)", 214)); // spelling
        Assert.Equal(SongMatch.Unsure, M("Glass Animals - Gooey (Official Lyric Video)", 290, "Glass Animals - Gooey", 290));  // lyric video
        Assert.Equal(SongMatch.Different, M("Apache Indian - Boom Shack-A-Lack (HQ Video)", 230, "Apache Indian - Boom Shack-a-Lak", 300));
    }
}

internal static class DuplicateFinderTests
{
    private sealed record Env(string Root, FakeProbe Probe, DuplicateFinder Finder, List<string> Log);

    private static Env Make()
    {
        var s = TestEnv.UseFakeYtDlp("ok");
        var root = Path.Combine(TestEnv.Root, "dups-" + Guid.NewGuid().ToString("N")[..6]);
        var nas = Path.Combine(root, "AutoDownload", "YoutubeHDx");
        Directory.CreateDirectory(Path.Combine(nas, "My MTV"));
        Directory.CreateDirectory(Path.Combine(root, "AutoDownload", "MyMTV"));
        Directory.CreateDirectory(Path.Combine(root, "needremix"));
        s.NasPath = nas;
        s.DuplicateFolders = ["../.."];
        SettingsStore.Save(s);
        if (File.Exists(AppPaths.DuplicateStateFile)) File.Delete(AppPaths.DuplicateStateFile);
        var probe = new FakeProbe();
        var log = new List<string>();
        return new Env(root, probe, new DuplicateFinder(SettingsStore.Load, probe, m => { lock (log) log.Add(m); }), log);
    }

    private static string Video(Env env, string relative, double duration, int height, long bitRate = 5_000_000)
    {
        var path = Path.Combine(env.Root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, new string('x', height)); // size follows quality
        env.Probe.Media[path] = new MediaInfo(duration, null, null, [], null, height * 16 / 9, height, bitRate);
        return path;
    }

    private static string Ignore(Env env, string dir) =>
        File.Exists(Path.Combine(env.Root, dir, ".plexignore")) ? File.ReadAllText(Path.Combine(env.Root, dir, ".plexignore")) : "";

    [Test]
    public static async Task HidesTheWorseCopiesAndKeepsTheBest()
    {
        var env = Make();
        File.WriteAllText(Path.Combine(env.Root, ".plexignore"), "Software/*\n"); // Doug's own line stays
        var old = Video(env, "Aqua - Barbie Girl.mkv", 197, 480);
        var mid = Video(env, Path.Combine("AutoDownload", "MyMTV", "Aqua - Barbie Girl (Official Music Video).mp4"), 198, 720);
        var best = Video(env, Path.Combine("AutoDownload", "YoutubeHDx", "My MTV", "Aqua - Barbie Girl (Official Music Video) [ZyhrYis509A].mkv"), 197.5, 2160);
        Video(env, "The Beatles - Let It Be.mkv", 243, 480);
        Video(env, "The Beatles - Let It Be (Live).mkv", 243, 1080);           // a different song: both stay
        Video(env, Path.Combine("needremix", "Aqua - Barbie Girl.mkv"), 197, 240); // skipped folder

        var r = await env.Finder.ScanAsync(CancellationToken.None);

        Assert.Equal(5, r.FilesChecked);
        Assert.Equal(2, r.Duplicates.Count);
        Assert.True(r.Duplicates.All(d => d.KeptPath == best && d.State == "ignored"));
        Assert.Equal(string.Join("|", new[] { mid, old }.OrderBy(x => x)), string.Join("|", r.Duplicates.Select(d => d.Path).OrderBy(x => x)));

        var rootIgnore = Ignore(env, "");
        Assert.True(rootIgnore.StartsWith("Software/*\n"));
        Assert.Contains("Aqua - Barbie Girl.mkv", rootIgnore);
        Assert.False(rootIgnore.Contains("Let It Be"));
        Assert.Contains("Aqua - Barbie Girl *Official Music Video*.mp4", Ignore(env, Path.Combine("AutoDownload", "MyMTV")));
        Assert.Equal("", Ignore(env, Path.Combine("AutoDownload", "YoutubeHDx", "My MTV")));
    }

    [Test]
    public static async Task UnignoreShowsItAgainForGood()
    {
        var env = Make();
        var old = Video(env, "Aqua - Barbie Girl.mkv", 197, 480);
        Video(env, Path.Combine("AutoDownload", "MyMTV", "Aqua - Barbie Girl (Official Music Video).mkv"), 197, 1080);
        await env.Finder.ScanAsync(CancellationToken.None);
        Assert.Contains("Aqua - Barbie Girl.mkv", Ignore(env, ""));

        var r = await env.Finder.UnignoreAsync([old]);
        Assert.Equal("shown", r.Duplicates.Single().State);
        Assert.False(Ignore(env, "").Contains("Barbie"));

        r = await env.Finder.ScanAsync(CancellationToken.None);       // a later scan respects it
        Assert.Equal("shown", r.Duplicates.Single().State);
        Assert.False(Ignore(env, "").Contains("Barbie"));

        r = await env.Finder.IgnoreAgainAsync([old]);
        Assert.Equal("ignored", r.Duplicates.Single().State);
        Assert.Contains("Aqua - Barbie Girl.mkv", Ignore(env, ""));
    }

    [Test]
    public static async Task RootPatternsApplyToTheWholeTreeSoSameNamesElsewhereAreProtected()
    {
        var env = Make();
        // In Plex, a pattern in the top folder's .plexignore matches that name in every subfolder too.
        Video(env, "Aqua - Barbie Girl.mkv", 197, 480);
        Video(env, Path.Combine("AutoDownload", "MyMTV", "Aqua - Barbie Girl.mkv"), 197, 1080);
        var r = await env.Finder.ScanAsync(CancellationToken.None);
        Assert.Equal("unsafe", r.Duplicates.Single().State);
        Assert.Equal("", Ignore(env, ""));
    }

    [Test]
    public static async Task NeverWritesAPatternThatWouldHideAnotherFile()
    {
        var env = Make();
        // "Song (A).mkv" becomes "Song *A*.mkv", which would also match "Song (Ab A).mkv" (a different, kept file).
        Video(env, "Band - Song (A).mkv", 200, 480);
        Video(env, Path.Combine("AutoDownload", "MyMTV", "Band - Song.mkv"), 200, 1080);
        Video(env, "Band - Song (Ab A) (Live).mkv", 200, 480);

        var r = await env.Finder.ScanAsync(CancellationToken.None);
        var d = r.Duplicates.Single();
        Assert.Equal("unsafe", d.State);
        Assert.Equal("", Ignore(env, ""));
    }

    [Test]
    public static async Task UnsurePairsWaitForYourAnswer()
    {
        var env = Make();
        var a = Video(env, "barracuda.mkv", 262, 360);
        var b = Video(env, Path.Combine("AutoDownload", "MyMTV", "Heart - Barracuda.mkv"), 262, 1080);

        var r = await env.Finder.ScanAsync(CancellationToken.None);
        Assert.Equal(0, r.Duplicates.Count);
        Assert.Equal(1, r.Check.Count);
        Assert.Contains("no artist", r.Check[0].Reason);

        r = await env.Finder.DecideAsync(a, b, sameSong: true, CancellationToken.None);
        Assert.Equal(a, r.Duplicates.Single().Path);
        Assert.Equal(0, r.Check.Count);
        Assert.Contains("barracuda.mkv", Ignore(env, ""));
    }

    [Test]
    public static async Task DifferentAnswerIsRemembered()
    {
        var env = Make();
        var a = Video(env, "barracuda.mkv", 262, 360);
        var b = Video(env, Path.Combine("AutoDownload", "MyMTV", "Heart - Barracuda.mkv"), 262, 1080);
        await env.Finder.ScanAsync(CancellationToken.None);

        var r = await env.Finder.DecideAsync(a, b, sameSong: false, CancellationToken.None);
        Assert.Equal(0, r.Check.Count);
        r = await env.Finder.ScanAsync(CancellationToken.None);
        Assert.Equal(0, r.Check.Count);
        Assert.Equal(0, r.Duplicates.Count);
    }

    [Test]
    public static async Task MoveTakesSubtitlesAlongAndCleansTheIgnoreList()
    {
        var env = Make();
        var old = Video(env, "Aqua - Barbie Girl.mkv", 197, 480);
        File.WriteAllText(Path.Combine(env.Root, "Aqua - Barbie Girl.eng.srt"), "subs");
        Video(env, Path.Combine("AutoDownload", "MyMTV", "Aqua - Barbie Girl.mkv"), 197, 1080);
        await env.Finder.ScanAsync(CancellationToken.None);

        var target = Path.Combine(TestEnv.Root, "moved-" + Guid.NewGuid().ToString("N")[..6]);
        var result = await env.Finder.MoveAsync([old], target, CancellationToken.None);

        Assert.Equal(1, result.Moved);
        Assert.True(File.Exists(Path.Combine(target, "Aqua - Barbie Girl.mkv")));
        Assert.True(File.Exists(Path.Combine(target, "Aqua - Barbie Girl.eng.srt")));
        Assert.False(File.Exists(old));
        Assert.Equal(0, env.Finder.Results.Duplicates.Count);
        Assert.False(Ignore(env, "").Contains("Barbie"));
    }

    [Test]
    public static async Task SecondScanUsesCachedFacts()
    {
        var env = Make();
        Video(env, "Aqua - Barbie Girl.mkv", 197, 480);
        Video(env, Path.Combine("AutoDownload", "MyMTV", "Aqua - Barbie Girl.mkv"), 197, 1080);
        await env.Finder.ScanAsync(CancellationToken.None);
        var probes = env.Probe.Probes;
        await env.Finder.ScanAsync(CancellationToken.None);
        Assert.Equal(probes, env.Probe.Probes);
    }

    [Test]
    public static void PatternsAvoidCharactersPlexMishandles()
    {
        Assert.Equal("Cinderella - Don't Know What You Got *Till It's Gone* *Official Video*.mkv",
            PlexIgnore.PatternFor("Cinderella - Don't Know What You Got (Till It's Gone) [Official Video].mkv"));
        Assert.True(PlexIgnore.Matches("Song *A*.mkv", "song (a).MKV"));
        Assert.False(PlexIgnore.Matches("Song *A*.mkv", "Song (A).mp4"));
    }
}
