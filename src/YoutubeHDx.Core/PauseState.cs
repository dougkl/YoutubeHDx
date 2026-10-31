using System.Text.Json;

namespace YoutubeHDx.Core;

/// <summary>Whether downloads are paused. <c>Until</c> is null for "until resumed".</summary>
public sealed record PauseState(bool IsPaused, DateTimeOffset? Until)
{
    public static readonly PauseState Running = new(false, null);

    public string Describe() => !IsPaused ? "Downloading"
        : Until is { } u ? $"Paused until {u.ToLocalTime():t}"
        : "Paused until you resume";
}

/// <summary>Keeps the pause across app restarts (so the keep-alive task can't undo it).</summary>
public static class PauseStore
{
    private sealed record Stored(bool Paused, DateTimeOffset? Until);

    public static PauseState Load()
    {
        try
        {
            if (!File.Exists(AppPaths.PauseFile)) return PauseState.Running;
            var s = JsonSerializer.Deserialize<Stored>(File.ReadAllText(AppPaths.PauseFile), Json.Options);
            if (s is null || !s.Paused) return PauseState.Running;
            if (s.Until is { } u && u <= DateTimeOffset.Now) return PauseState.Running; // expired while we were off
            return new PauseState(true, s.Until);
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return PauseState.Running;
        }
    }

    public static void Save(PauseState state)
    {
        try
        {
            AppPaths.EnsureDataDir();
            File.WriteAllText(AppPaths.PauseFile, JsonSerializer.Serialize(new Stored(state.IsPaused, state.Until), Json.Options));
        }
        catch (IOException)
        {
            // best effort: the pause still applies until the app restarts
        }
    }
}
