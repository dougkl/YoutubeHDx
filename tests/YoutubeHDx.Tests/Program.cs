using YoutubeHDx.Tests;

// The queue tests launch this same exe as a stand-in for yt-dlp.
if (FakeYtDlp.IsRequested) return await FakeYtDlp.RunAsync(args);

// Isolate everything the app writes into a throwaway folder.
// Must happen before anything touches AppPaths (its DataDir is read once).
var sandbox = TestEnv.CreateSandbox();
Console.WriteLine($"Sandbox: {sandbox}\n");

var failures = await Runner.RunAllAsync(args.FirstOrDefault());
TestEnv.DeleteSandbox();
return failures;
