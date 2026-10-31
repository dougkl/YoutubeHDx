using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace YoutubeHDx.Core;

/// <summary>Runs one yt-dlp process for a job and translates its output into job progress.</summary>
public sealed class YtDlpRunner
{
    private readonly Action<string> _log;

    public YtDlpRunner(Action<string> log) => _log = log;

    public async Task<int> RunAsync(DownloadJob job, AppSettings s, CancellationToken ct)
    {
        if (!Directory.Exists(s.NasPath))
            throw new InvalidOperationException(
                $"NAS folder '{s.NasPath}' is not reachable. Check the path in settings.json and that this user can write to it.");
        if (s.RequireLogin && !CookieFile.HasLogin(AppPaths.CookiesFile))
            throw new InvalidOperationException(
                "Not signed in: no YouTube login cookies yet. Sign in to YouTube in Chrome and click the YoutubeHDx " +
                "extension icon once (or set requireLogin to false to allow anonymous downloads).");
        Directory.CreateDirectory(s.TempPath);

        var psi = new ProcessStartInfo(s.YtDlpPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in YtDlpArgs.Build(s, job, AppPaths.CookiesFile)) psi.ArgumentList.Add(arg);
        psi.Environment["PYTHONIOENCODING"] = "utf-8";

        using var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (_, e) => { if (e.Data is not null) HandleStdout(job, e.Data); };
        p.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            _log($"[yt-dlp] {e.Data}");
            if (e.Data.StartsWith("ERROR:", StringComparison.Ordinal)) job.SetError(e.Data);
        };

        _log($"Starting job {job.Id}: {job.Url}");
        try
        {
            p.Start();
        }
        catch (Win32Exception ex)
        {
            throw new InvalidOperationException(
                $"Could not start yt-dlp ('{s.YtDlpPath}'): {ex.Message}. Install it (winget install yt-dlp.yt-dlp) or set YtDlpPath.", ex);
        }

        p.BeginOutputReadLine();
        p.BeginErrorReadLine();

        using (ct.Register(() => { try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { /* already gone */ } }))
        {
            await p.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        }

        ct.ThrowIfCancellationRequested();
        _log($"Job {job.Id} exited with code {p.ExitCode}");
        return p.ExitCode;
    }

    private void HandleStdout(DownloadJob job, string line)
    {
        if (line.StartsWith(YtDlpArgs.ProgressMarker, StringComparison.Ordinal))
        {
            // [HDX]id|  45.3%|  12.34MiB/s|00:21
            var parts = line[YtDlpArgs.ProgressMarker.Length..].Split('|');
            if (parts.Length >= 4 &&
                double.TryParse(parts[1].Trim().TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out var pct))
            {
                job.ReportProgress(pct, Clean(parts[2]), Clean(parts[3]));
            }
            return;
        }

        if (line.StartsWith(YtDlpArgs.StartMarker, StringComparison.Ordinal))
        {
            var payload = line[YtDlpArgs.StartMarker.Length..];
            var sep = payload.IndexOf('|');
            job.ItemStarted(sep >= 0 ? payload[(sep + 1)..] : payload);
            _log($"Downloading: {payload}");
            return;
        }

        if (line.StartsWith(YtDlpArgs.DoneMarker, StringComparison.Ordinal))
        {
            var file = line[YtDlpArgs.DoneMarker.Length..];
            job.ItemCompleted(file);
            _log($"Saved: {file}");
            return;
        }

        _log($"[yt-dlp] {line}");
    }

    private static string? Clean(string s)
    {
        s = s.Trim();
        return s is "" or "NA" or "Unknown" or "N/A" ? null : s;
    }
}
