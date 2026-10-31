namespace YoutubeHDx.Core;

/// <summary>Tiny append-only log in %LocalAppData%\YoutubeHDx. Rolls over at 5 MB.</summary>
public static class FileLog
{
    private const long MaxBytes = 5 * 1024 * 1024;
    private static readonly object Gate = new();

    public static void Write(string message)
    {
        lock (Gate)
        {
            try
            {
                AppPaths.EnsureDataDir();
                var path = AppPaths.LogFile;
                var info = new FileInfo(path);
                if (info.Exists && info.Length > MaxBytes)
                    File.Move(path, path + ".old", overwrite: true);
                File.AppendAllText(path, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
            catch (IOException)
            {
                // logging must never take the app down
            }
        }
    }
}
