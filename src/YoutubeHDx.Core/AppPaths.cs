namespace YoutubeHDx.Core;

/// <summary>Well-known locations shared by the tray app and the native messaging host.</summary>
public static class AppPaths
{
    /// <summary>Name of the environment variable that overrides <see cref="DataDir"/> (used by the tests).</summary>
    public const string DataDirOverrideVariable = "YOUTUBEHDX_DATA_DIR";

    // On Windows, LocalApplicationData comes from the shell's known-folder API, not %LOCALAPPDATA%,
    // so an explicit override is the only reliable way to redirect it.
    public static string DataDir { get; } =
        Environment.GetEnvironmentVariable(DataDirOverrideVariable) is { Length: > 0 } overrideDir
            ? overrideDir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YoutubeHDx");

    public static string SettingsFile => Path.Combine(DataDir, "settings.json");

    /// <summary>Netscape-format cookies exported by the extension. Lives in the user's own profile only.</summary>
    public static string CookiesFile => Path.Combine(DataDir, "youtube-cookies.txt");

    public static string LogFile => Path.Combine(DataDir, "youtubehdx.log");

    public static string PauseFile => Path.Combine(DataDir, "pause.json");

    /// <summary>Jobs not finished yet, so they survive a crash or restart.</summary>
    public static string QueueFile => Path.Combine(DataDir, "queue.json");

    /// <summary>
    /// Per-user pipe name; the pipe is also created with CurrentUserOnly. When the data folder is overridden
    /// (tests), the name includes a hash of that folder so it can never reach the real running app.
    /// </summary>
    public static string PipeName { get; } = BuildPipeName();

    private static string BuildPipeName()
    {
        var name = "YoutubeHDx.Ipc." + Environment.UserName;
        if (Environment.GetEnvironmentVariable(DataDirOverrideVariable) is not { Length: > 0 }) return name;

        // Stable across processes (string.GetHashCode is randomized per process), so the native host child matches.
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(DataDir));
        return name + "." + Convert.ToHexString(hash, 0, 6);
    }

    public static void EnsureDataDir() => Directory.CreateDirectory(DataDir);
}
