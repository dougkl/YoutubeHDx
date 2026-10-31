namespace YoutubeHDx.App;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, "YoutubeHDx.App." + Environment.UserName, out var firstInstance);
        if (!firstInstance) return; // already running in the tray

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}
