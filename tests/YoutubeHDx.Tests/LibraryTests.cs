using System.Net;
using System.Xml.Linq;
using YoutubeHDx.Core;
using YoutubeHDx.Core.Library;
using YoutubeHDx.Core.Lyrics;
using YoutubeHDx.Core.Subtitles;

namespace YoutubeHDx.Tests;

internal static class LibraryTests
{
    private static string NewNas()
    {
        var nas = Path.Combine(TestEnv.Root, "lib-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(Path.Combine(nas, "My MTV"));
        return nas;
    }

    private static string Touch(string nas, string name, string text = "x")
    {
        var path = Path.Combine(nas, "My MTV", name);
        File.WriteAllText(path, text);
        return path;
    }

    private static string[] Names(string nas) =>
        Directory.GetFiles(Path.Combine(nas, "My MTV")).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!;

    // ---------------------------------------------------------------- file names

    [Test]
    public static void NewDownloadsHaveNoDateInFront()
    {
        Assert.Equal("%(playlist_title|Singles)s/%(title)s [%(id)s].%(ext)s", new AppSettings().OutputTemplate);
    }

    [Test]
    public static void OldDefaultTemplateIsUpgradedButCustomOnesAreKept()
    {
        var s = TestEnv.UseFakeYtDlp("ok");
        s.OutputTemplate = AppSettings.DatedOutputTemplate;
        SettingsStore.Save(s);
        Assert.Equal(AppSettings.DefaultOutputTemplate, SettingsStore.Load().OutputTemplate);
        Assert.False(File.ReadAllText(AppPaths.SettingsFile).Contains("upload_date")); // saved, not just in memory

        s.OutputTemplate = "%(uploader)s/%(upload_date)s %(title)s [%(id)s].%(ext)s"; // someone's own choice
        SettingsStore.Save(s);
        Assert.Equal(s.OutputTemplate, SettingsStore.Load().OutputTemplate);
    }

    [Test]
    public static void RemovesDateFromVideoAndItsSidecarsTogether()
    {
        var nas = NewNas();
        const string dated = "2014-07-18 - Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs]";
        Touch(nas, dated + ".mkv", "video");
        Touch(nas, dated + ".en.srt");
        Touch(nas, dated + ".en.lyrics.srt");
        Touch(nas, dated + ".jpg");
        Touch(nas, "2012-01-01 - Rick Astley - Never Gonna Give You Up [dQw4w9WgXcQ].mkv");
        Touch(nas, "Already Fine [abcdefghijk].mkv");
        Touch(nas, "2001-09-09 - holiday.mkv");                                // not ours: no [id]
        Touch(nas, "2015-05-05 - Downloading [zzzzzzzzzzz].mkv.part");        // unfinished download

        var log = new List<string>();
        var summary = DatedNameFixer.Fix(nas, log.Add);

        Assert.Equal(5, summary.Renamed);
        Assert.Equal(0, summary.Conflicts);
        var names = Names(nas);
        Assert.Contains("Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].mkv", names);
        Assert.Contains("Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].en.srt", names);
        Assert.Contains("Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].en.lyrics.srt", names);
        Assert.Contains("Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].jpg", names);
        Assert.Contains("Rick Astley - Never Gonna Give You Up [dQw4w9WgXcQ].mkv", names);
        Assert.Contains("Already Fine [abcdefghijk].mkv", names);
        Assert.Contains("2001-09-09 - holiday.mkv", names);
        Assert.Contains("2015-05-05 - Downloading [zzzzzzzzzzz].mkv.part", names);
        Assert.Equal("video", File.ReadAllText(Path.Combine(nas, "My MTV", "Pink Floyd - Learning To Fly (Official Music Video HD) [nVhNCTH8pDs].mkv")));

        var csv = File.ReadAllLines(Path.Combine(nas, DatedNameFixer.CsvName));
        Assert.Equal("renamed_at,folder,old_name,new_name", csv[0].TrimStart('﻿'));
        Assert.Equal(6, csv.Length);
        Assert.True(csv.Any(l => l.Contains("My MTV,2012-01-01 - Rick Astley - Never Gonna Give You Up [dQw4w9WgXcQ].mkv,Rick Astley")));

        // Running again finds nothing to do.
        Assert.Equal(0, DatedNameFixer.Fix(nas, log.Add).Renamed);
    }

    [Test]
    public static void NeverOverwritesAndKeepsAPairTogetherWhenANameIsTaken()
    {
        var nas = NewNas();
        Touch(nas, "2014-07-18 - Song [nVhNCTH8pDs].mkv", "old");
        Touch(nas, "2014-07-18 - Song [nVhNCTH8pDs].en.srt");
        Touch(nas, "Song [nVhNCTH8pDs].mkv", "new");                           // the video was downloaded again

        var summary = DatedNameFixer.Fix(nas, _ => { });

        Assert.Equal(0, summary.Renamed);
        Assert.Equal(2, summary.Conflicts);
        Assert.Equal("new", File.ReadAllText(Path.Combine(nas, "My MTV", "Song [nVhNCTH8pDs].mkv")));
        Assert.Contains("2014-07-18 - Song [nVhNCTH8pDs].en.srt", Names(nas)); // not split from its video
    }

    // ---------------------------------------------------------------- info files

    private static MediaInfo Tagged(double duration = 241) => new(duration, "Peter Schilling - Major Tom (Coming Home) (Official Video)",
        "Peter Schilling", [], new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["DATE"] = "20200214",
            ["DESCRIPTION"] = "Remastered in HD & more <fun>",
            ["GENRE"] = "Music",
        });

    [Test]
    public static void NfoHasArtistSongAndYouTubeDetails()
    {
        var xml = XDocument.Parse(System.Text.Encoding.UTF8.GetString(InfoFileWriter.BuildNfo(
            "wO0A0XcWy88", "x.mkv", Tagged(), "My MTV (Always updated)")));
        var movie = xml.Root!;
        Assert.Equal("movie", movie.Name.LocalName);
        Assert.Equal("Peter Schilling - Major Tom (Coming Home)", movie.Element("title")!.Value);
        Assert.Equal("Peter Schilling - Major Tom (Coming Home) (Official Video)", movie.Element("originaltitle")!.Value);
        Assert.Equal("Peter Schilling", movie.Element("artist")!.Value);
        Assert.Equal("Peter Schilling", movie.Element("set")!.Element("name")!.Value);
        Assert.Equal("4", movie.Element("runtime")!.Value);
        Assert.Contains("Remastered in HD & more <fun>", movie.Element("plot")!.Value);
        Assert.Contains("https://www.youtube.com/watch?v=wO0A0XcWy88 (uploaded 2020-02-14)", movie.Element("plot")!.Value);
        Assert.Equal("wO0A0XcWy88", movie.Element("uniqueid")!.Value);
        Assert.Equal("youtube", movie.Element("uniqueid")!.Attribute("type")!.Value);
        Assert.Contains("My MTV (Always updated)", movie.Elements("tag").Select(t => t.Value));
        Assert.Equal(null, movie.Element("year"));   // the upload year is not the song's year
    }

    [Test]
    public static void VevoChannelGivesTheArtistWhenTheTitleHasNone()
    {
        var media = new MediaInfo(263, "Don't You (Forget About Me)", "SimpleMindsVEVO", []);
        var movie = XDocument.Parse(System.Text.Encoding.UTF8.GetString(InfoFileWriter.BuildNfo("CdqoNKCCt7A", "x.mkv", media, null))).Root!;
        Assert.Equal("Simple Minds - Don't You (Forget About Me)", movie.Element("title")!.Value);
        Assert.Equal("YouTube", string.Join(",", movie.Elements("tag").Select(t => t.Value)));
    }

    private static (InfoFileWriter Writer, FakeProbe Probe, FakeHttp Http, string Nas) MakeWriter(HttpStatusCode thumbStatus = HttpStatusCode.OK)
    {
        var nas = NewNas();
        var s = TestEnv.UseFakeYtDlp("ok");
        s.NasPath = nas;
        SettingsStore.Save(s);
        var probe = new FakeProbe();
        var http = new FakeHttp(_ => new HttpResponseMessage(thumbStatus) { Content = new ByteArrayContent(new byte[5000]) });
        return (new InfoFileWriter(SettingsStore.Load, probe, new HttpClient(http), _ => { }), probe, http, nas);
    }

    [Test]
    public static async Task WritesNfoAndThumbnailOnlyWhenMissing()
    {
        var (writer, probe, http, nas) = MakeWriter();
        const string stem = "Peter Schilling - Major Tom [wO0A0XcWy88]";
        Touch(nas, stem + ".mkv");
        probe.Media[stem + ".mkv"] = Tagged();
        Touch(nas, "Has Everything [abcdefghijk].mkv");
        Touch(nas, "Has Everything [abcdefghijk].nfo", "mine");
        Touch(nas, "Has Everything [abcdefghijk].webp", "mine");

        var summary = await writer.WriteAllAsync(CancellationToken.None);
        Assert.Equal(1, summary.Nfos);
        Assert.Equal(1, summary.Pictures);
        Assert.Contains("<artist>Peter Schilling</artist>", File.ReadAllText(Path.Combine(nas, "My MTV", stem + ".nfo")));
        Assert.Equal(5000, (int)new FileInfo(Path.Combine(nas, "My MTV", stem + ".jpg")).Length);
        Assert.Equal("https://i.ytimg.com/vi/wO0A0XcWy88/maxresdefault.jpg", http.Urls.Single());
        Assert.Equal("mine", File.ReadAllText(Path.Combine(nas, "My MTV", "Has Everything [abcdefghijk].nfo")));
        Assert.Equal(1, probe.Probes);                                      // the complete one isn't even opened

        var again = await writer.WriteAllAsync(CancellationToken.None);
        Assert.Equal(0, again.Nfos + again.Pictures);
        Assert.Equal(1, probe.Probes);
    }

    [Test]
    public static async Task UsesAFrameFromTheVideoWhenYouTubeHasNoThumbnail()
    {
        var (writer, probe, http, nas) = MakeWriter(HttpStatusCode.NotFound);
        const string stem = "Removed Song [gone0000001]";
        var video = Touch(nas, stem + ".mkv");
        probe.Media[stem + ".mkv"] = Tagged();
        probe.Frame = new byte[3000];

        var summary = await writer.WriteForAsync(video, CancellationToken.None);
        Assert.Equal(1, summary.Pictures);
        Assert.Equal(3, http.Urls.Count);                                   // maxres, sd, hq all tried first
        Assert.Equal(1, probe.FrameGrabs);
        Assert.True(File.Exists(Path.Combine(nas, "My MTV", stem + ".jpg")));
    }

    [Test]
    public static void DownloadsKeepTheThumbnailFile()
    {
        var s = new AppSettings();
        Assert.Contains("--write-thumbnail", YtDlpArgs.Build(s, new DownloadJob { Url = "https://youtu.be/x", NoPlaylist = true }, null));
        s.WriteInfoFiles = false;
        Assert.DoesNotContain("--write-thumbnail", YtDlpArgs.Build(s, new DownloadJob { Url = "https://youtu.be/x", NoPlaylist = true }, null));
    }

    // ---------------------------------------------------------------- subtitle scan after renaming

    [Test]
    public static async Task SubtitleScanRecognisesRenamedFilesWithoutRecheckingThem()
    {
        var s = TestEnv.UseFakeYtDlp("ok");
        var nas = NewNas();
        s.NasPath = nas;
        SettingsStore.Save(s);
        if (File.Exists(AppPaths.SubtitleStateFile)) File.Delete(AppPaths.SubtitleStateFile);
        var probe = new FakeProbe();
        var http = new FakeHttp(_ => FakeHttp.Json("[]"));
        var scanner = new SubtitleScanner(SettingsStore.Load, probe, st => new LyricsFinder(new HttpClient(http), ""),
            () => false, _ => { }, null, TimeSpan.Zero);

        const string dated = "2020-02-14 - Peter Schilling - Major Tom [wO0A0XcWy88]";
        Touch(nas, dated + ".mkv");
        File.WriteAllText(Path.Combine(nas, "My MTV", dated + ".en.srt"),
            "1\n00:00:05,000 --> 00:00:08,000\na\n\n2\n00:01:00,000 --> 00:01:05,000\nb\n\n3\n00:03:20,000 --> 00:03:30,000\nc\n");
        probe.Media[dated + ".mkv"] = new MediaInfo(240, null, null, []);
        Assert.Equal(1, (await scanner.ScanAllAsync(CancellationToken.None)).AlreadyGood);

        DatedNameFixer.Fix(nas, _ => { });
        var probes = probe.Probes;
        var again = await scanner.ScanAllAsync(CancellationToken.None);
        Assert.Equal(0, again.Checked);
        Assert.Equal(probes, probe.Probes);
    }
}
