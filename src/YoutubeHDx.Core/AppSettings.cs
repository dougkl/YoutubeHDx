using System.Text.Json;
using System.Text.Json.Serialization;

namespace YoutubeHDx.Core;

public sealed class AppSettings
{
    /// <summary>Final destination. UNC path (\\nas\share\YouTube) or a mapped drive.</summary>
    public string NasPath { get; set; } = @"\\nas\media\YouTube";

    /// <summary>Local scratch folder. Streams are downloaded and merged here, then moved to the NAS.</summary>
    public string TempPath { get; set; } = Path.Combine(Path.GetTempPath(), "YoutubeHDx");

    /// <summary>yt-dlp executable. A bare name is resolved from PATH (winget installs it there).</summary>
    public string YtDlpPath { get; set; } = "yt-dlp.exe";

    /// <summary>Folder containing ffmpeg.exe, or the exe itself. Empty = PATH.</summary>
    public string FfmpegLocation { get; set; } = "";

    public int MaxHeight { get; set; } = 2160;

    /// <summary>yt-dlp --sub-langs value. Only human-made tracks are downloaded (auto captions are never requested).</summary>
    public string SubtitleLanguages { get; set; } = "en.*,-live_chat";

    /// <summary>Embed the English track inside the .mkv.</summary>
    public bool EmbedSubtitles { get; set; } = true;

    /// <summary>Also keep a sidecar .srt next to the .mkv (handy for Plex/Jellyfin).</summary>
    public bool KeepSubtitleFiles { get; set; } = true;

    /// <summary>
    /// yt-dlp output template, relative to NasPath. "Artist - Song [id].mkv": no date in front, so Plex reads
    /// the artist and title from the name. The [id] stays: the subtitle scan uses it to know which video it is.
    /// </summary>
    public string OutputTemplate { get; set; } = DefaultOutputTemplate;

    public const string DefaultOutputTemplate = "%(playlist_title|Singles)s/%(title)s [%(id)s].%(ext)s";

    /// <summary>The template used up to 1.4.0, with the upload date in front. Saved settings using it are upgraded.</summary>
    public const string DatedOutputTemplate = "%(playlist_title|Singles)s/%(upload_date>%Y-%m-%d)s - %(title)s [%(id)s].%(ext)s";

    /// <summary>Extra raw yt-dlp arguments, e.g. a PO token provider's --extractor-args.</summary>
    public string ExtraArgs { get; set; } = "";

    public int MaxConcurrentDownloads { get; set; } = 1;

    /// <summary>
    /// Refuse to download without your YouTube login cookies (sent by the extension), so nothing is ever
    /// fetched anonymously. Your account is what unlocks Premium formats, private playlists and Watch Later.
    /// </summary>
    public bool RequireLogin { get; set; } = true;

    /// <summary>Playlists checked automatically. Already-downloaded videos are skipped via the archive file.</summary>
    public List<WatchedPlaylist> WatchedPlaylists { get; set; } = new();

    public int WatchIntervalMinutes { get; set; } = 360;

    /// <summary>Check downloaded videos for missing/bad English subtitles and add song lyrics where possible.</summary>
    public bool SubtitleScan { get; set; } = true;

    /// <summary>Hours between automatic full subtitle scans (new downloads are checked right away).</summary>
    public int SubtitleScanIntervalHours { get; set; } = 24;

    /// <summary>Optional OpenSubtitles API key, used when LRCLIB has no matching lyrics.</summary>
    public string OpenSubtitlesApiKey { get; set; } = "";

    /// <summary>
    /// Next to each video, write "Name [id].nfo" (artist, song, description, YouTube link) and "Name [id].jpg"
    /// (the YouTube thumbnail) so Plex (NFO agent), Jellyfin, Emby and Kodi show proper details and pictures.
    /// </summary>
    public bool WriteInfoFiles { get; set; } = true;

    /// <summary>Rename files saved by older versions ("2014-07-18 - Title [id].mkv") to drop the date (only while the template has no date).</summary>
    public bool FixDatedFileNames { get; set; } = true;

    /// <summary>Write unavailable videos (removed, private, blocked...) to a CSV in the download folder.</summary>
    public bool ReportUnavailable { get; set; } = true;

    [JsonIgnore]
    public string ArchiveFile => Path.Combine(NasPath, ".youtubehdx-archive.txt");
}

public sealed class WatchedPlaylist
{
    public string Url { get; set; } = "";
    public string? Name { get; set; }
    public bool Enabled { get; set; } = true;
}

public static class SettingsStore
{
    private static readonly object Gate = new();

    public static AppSettings Load()
    {
        lock (Gate)
        {
            AppPaths.EnsureDataDir();
            if (!File.Exists(AppPaths.SettingsFile))
            {
                var fresh = new AppSettings();
                SaveUnlocked(fresh);
                return fresh;
            }

            try
            {
                var loaded = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(AppPaths.SettingsFile), Json.Options)
                             ?? new AppSettings();
                if (loaded.OutputTemplate == AppSettings.DatedOutputTemplate)
                {
                    // Old default: the date in front of the name confused Plex. Only the untouched default is changed.
                    loaded.OutputTemplate = AppSettings.DefaultOutputTemplate;
                    SaveUnlocked(loaded);
                }
                return loaded;
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException(
                    $"settings.json is not valid JSON ({ex.Message}). File: {AppPaths.SettingsFile}", ex);
            }
        }
    }

    public static void Save(AppSettings settings)
    {
        lock (Gate) SaveUnlocked(settings);
    }

    /// <summary>Adds a playlist to the watch list if it isn't there already. Returns false if it was already watched.</summary>
    public static bool AddWatchedPlaylist(string url, string? name = null)
    {
        lock (Gate)
        {
            var s = Load();
            if (s.WatchedPlaylists.Any(p => string.Equals(p.Url, url, StringComparison.OrdinalIgnoreCase)))
                return false;
            s.WatchedPlaylists.Add(new WatchedPlaylist { Url = url, Name = name });
            SaveUnlocked(s);
            return true;
        }
    }

    private static void SaveUnlocked(AppSettings settings)
    {
        AppPaths.EnsureDataDir();
        var tmp = AppPaths.SettingsFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(settings, Json.Options));
        File.Move(tmp, AppPaths.SettingsFile, overwrite: true);
    }
}
