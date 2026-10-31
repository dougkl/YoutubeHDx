using YoutubeHDx.Core;

namespace YoutubeHDx.Tests;

/// <summary>Sandboxed data folder, fake NAS, and the fake yt-dlp (this test exe in FakeYtDlp mode).</summary>
internal static class TestEnv
{
    public static string Root { get; private set; } = "";
    public static string Nas => Path.Combine(Root, "nas");
    public static string Temp => Path.Combine(Root, "temp");
    private static string ArgsFile => Path.Combine(Root, "args.txt");

    public static string CreateSandbox()
    {
        Root = Path.Combine(Path.GetTempPath(), "yhdx-tests-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(Nas);
        Directory.CreateDirectory(Temp);

        // Inherited by the native host process the tests start, so it uses the same sandbox.
        var data = Path.Combine(Root, "appdata");
        Directory.CreateDirectory(data);
        Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, data);

        if (!AppPaths.DataDir.StartsWith(Root, StringComparison.Ordinal))
            throw new InvalidOperationException($"Could not sandbox AppPaths.DataDir ({AppPaths.DataDir}); refusing to touch real settings.");
        if (AppPaths.PipeName == "YoutubeHDx.Ipc." + Environment.UserName)
            throw new InvalidOperationException("Test pipe name equals the real app's; refusing to talk to the running app.");
        return Root;
    }

    public static void DeleteSandbox()
    {
        Environment.SetEnvironmentVariable(FakeYtDlp.ModeVariable, null);
        // Windows may still hold a handle briefly after a killed child exits.
        for (var i = 0; i < 5; i++)
        {
            try { Directory.Delete(Root, recursive: true); return; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Thread.Sleep(300); }
        }
    }

    /// <summary>
    /// Points settings at the fake NAS and at this test exe acting as yt-dlp.
    /// Modes: ok (one video), playlist-partial (one saved, one error, exit 1), fail (error, exit 1), slow (runs until killed).
    /// </summary>
    public static AppSettings UseFakeYtDlp(string mode)
    {
        Environment.SetEnvironmentVariable(FakeYtDlp.ModeVariable, mode);
        Environment.SetEnvironmentVariable(FakeYtDlp.ArgsFileVariable, ArgsFile);
        Environment.SetEnvironmentVariable(FakeYtDlp.NasVariable, Nas);
        if (File.Exists(ArgsFile)) File.Delete(ArgsFile);
        if (File.Exists(ArgsFile + ".ran")) File.Delete(ArgsFile + ".ran");

        var exe = Environment.ProcessPath
                  ?? throw new InvalidOperationException("Cannot find the test exe to use as fake yt-dlp.");
        if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Run the tests through their own exe (dotnet run), not 'dotnet <dll>'.");

        var s = new AppSettings { NasPath = Nas, TempPath = Temp, YtDlpPath = exe, RequireLogin = false };
        SettingsStore.Save(s);
        return s;
    }

    /// <summary>Clears saved pause and queue state so every test starts from a clean, unpaused, empty queue.</summary>
    public static void ResetAppState()
    {
        foreach (var f in new[] { AppPaths.PauseFile, AppPaths.QueueFile })
            if (File.Exists(f)) File.Delete(f);
    }

    /// <summary>Arguments the fake received, one per line, exactly as passed.</summary>
    public static string ReadFakeArgs() => File.ReadAllText(ArgsFile);
}
