namespace YoutubeHDx.Tests;

/// <summary>
/// When the test exe is started with YHDX_FAKE_YTDLP set, it pretends to be yt-dlp: it records its
/// arguments and prints the markers YtDlpRunner parses. Being a real exe (not a .cmd/.sh script)
/// means arguments reach it exactly as the app passes them, with no shell parsing on any OS.
/// </summary>
internal static class FakeYtDlp
{
    public const string ModeVariable = "YHDX_FAKE_YTDLP";
    public const string ArgsFileVariable = "YHDX_FAKE_YTDLP_ARGS";
    public const string NasVariable = "YHDX_FAKE_YTDLP_NAS";

    public static bool IsRequested => Environment.GetEnvironmentVariable(ModeVariable) is { Length: > 0 };

    public static async Task<int> RunAsync(string[] args)
    {
        var mode = Environment.GetEnvironmentVariable(ModeVariable)!;
        var nas = Environment.GetEnvironmentVariable(NasVariable) ?? "";
        if (Environment.GetEnvironmentVariable(ArgsFileVariable) is { Length: > 0 } argsFile)
            await File.WriteAllLinesAsync(argsFile, args);

        switch (mode)
        {
            case "ok":
                Out("[HDXSTART]vid1|First Video");
                Out("[HDX]vid1|  45.3%| 12.00MiB/s|00:10");
                Out("[HDX]vid1| 100.0%| 12.00MiB/s|00:00");
                Out($"[HDXDONE]{Path.Combine(nas, "Singles", "First Video [vid1].mkv")}");
                return 0;

            case "playlist-partial":
                Out("[HDXSTART]vid1|First Video");
                Out($"[HDXDONE]{Path.Combine(nas, "PL", "First Video [vid1].mkv")}");
                Console.Error.WriteLine("ERROR: [youtube] vid2: Video unavailable");
                return 1;

            case "fail":
                Console.Error.WriteLine("ERROR: [youtube] vid9: Sign in to confirm your age");
                return 1;

            case "slow-then-ok":
                // First run: hangs like a long download (so a pause can interrupt it). Later runs: succeed.
                var marker = (Environment.GetEnvironmentVariable(ArgsFileVariable) ?? "args.txt") + ".ran";
                if (File.Exists(marker)) goto case "ok";
                await File.WriteAllTextAsync(marker, "1");
                Out("[HDXSTART]vid1|First Video");
                await Task.Delay(TimeSpan.FromSeconds(30));
                return 0;

            case "slow":
                Out("[HDXSTART]vid1|Slow Video");
                await Task.Delay(TimeSpan.FromSeconds(30));
                return 0;

            default:
                Console.Error.WriteLine($"ERROR: unknown fake mode '{mode}'");
                return 2;
        }
    }

    private static void Out(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }
}
