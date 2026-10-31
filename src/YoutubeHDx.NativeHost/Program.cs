using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using YoutubeHDx.Core;

namespace YoutubeHDx.NativeHost;

/// <summary>
/// Chrome native messaging host. Chrome starts this exe per message; it saves the cookies the extension
/// sent, hands the request to the tray app over a named pipe (starting the app if needed), and replies.
/// It never talks to YouTube itself and never writes anything to stdout except protocol frames.
/// </summary>
internal static class Program
{
    private const int MaxIncomingBytes = 4 * 1024 * 1024;

    private sealed record HostRequest(
        string Type,
        string? Url = null,
        bool NoPlaylist = false,
        Guid? JobId = null,
        int? Minutes = null,
        List<BrowserCookie>? Cookies = null);

    private static async Task<int> Main()
    {
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();

        while (true)
        {
            byte[]? frame;
            try { frame = await ReadFrameAsync(stdin); }
            catch (Exception ex) { FileLog.Write($"[host] bad frame: {ex.Message}"); return 1; }
            if (frame is null) return 0; // Chrome closed stdin

            IpcResponse reply;
            try
            {
                var request = JsonSerializer.Deserialize<HostRequest>(frame, Json.Compact)
                              ?? throw new InvalidOperationException("Empty message.");
                reply = await HandleAsync(request);
            }
            catch (Exception ex)
            {
                FileLog.Write($"[host] {ex}");
                reply = new IpcResponse(false, ex.Message);
            }

            await WriteFrameAsync(stdout, JsonSerializer.SerializeToUtf8Bytes(reply, Json.Compact));
        }
    }

    private static async Task<IpcResponse> HandleAsync(HostRequest r)
    {
        // Refresh the cookie file whenever the extension sends a fresh copy of the browser session.
        if (r.Cookies is { Count: > 0 })
            CookieFile.WriteNetscape(AppPaths.CookiesFile, r.Cookies);

        switch (r.Type)
        {
            case "cookies":
                return CookieFile.HasLogin(AppPaths.CookiesFile)
                    ? new IpcResponse(true, "Signed in. Login sent to YoutubeHDx.")
                    : new IpcResponse(false, "No YouTube login received. Sign in to YouTube in Chrome.");
            case "download":
                return await SendToAppAsync(new IpcRequest("enqueue", Require(r.Url), r.NoPlaylist));
            case "watch":
                return await SendToAppAsync(new IpcRequest("watch", Require(r.Url)));
            case "cancel":
                return await SendToAppAsync(new IpcRequest("cancel", JobId: r.JobId));
            case "status":
                return await SendToAppAsync(new IpcRequest("status"), startIfNeeded: false);
            case "pause":
                return await SendToAppAsync(new IpcRequest("pause", Minutes: r.Minutes), startIfNeeded: false);
            case "resume":
                return await SendToAppAsync(new IpcRequest("resume"), startIfNeeded: false);
            case "ping":
                return new IpcResponse(true, "Host OK.");
            default:
                return new IpcResponse(false, $"Unknown message type '{r.Type}'.");
        }
    }

    private static string Require(string? url) =>
        string.IsNullOrWhiteSpace(url) ? throw new InvalidOperationException("Missing URL.") : url;

    private static async Task<IpcResponse> SendToAppAsync(IpcRequest request, bool startIfNeeded = true)
    {
        // TimeoutException = nothing listening; IOException = the app was closing as we connected.
        // A retried enqueue is safe: the app ignores a URL that is already queued.
        try
        {
            return await IpcClient.SendAsync(request, connectTimeoutMs: 400);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException && startIfNeeded)
        {
            StartApp();
        }
        catch (Exception ex) when (ex is TimeoutException or IOException)
        {
            return new IpcResponse(false, "YoutubeHDx app is not running.");
        }

        // Wait up to ~10 s for the freshly started app to open its pipe.
        for (var i = 0; i < 20; i++)
        {
            await Task.Delay(500);
            try { return await IpcClient.SendAsync(request, connectTimeoutMs: 300); }
            catch (Exception ex) when (ex is TimeoutException or IOException) { /* not up yet */ }
        }
        return new IpcResponse(false, "Started the YoutubeHDx app but it did not respond. Check the log in %LocalAppData%\\YoutubeHDx.");
    }

    private static void StartApp()
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "YoutubeHDx.App.exe");
        if (!File.Exists(exe))
            throw new InvalidOperationException($"YoutubeHDx.App.exe not found next to the host ({AppContext.BaseDirectory}).");

        // Launch through explorer so the app isn't tied to Chrome's job object and survives this host exiting.
        Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { exe }, UseShellExecute = false });
        FileLog.Write("[host] started YoutubeHDx.App");
    }

    // ---- Native messaging framing: 4-byte little-endian length + UTF-8 JSON ----

    private static async Task<byte[]?> ReadFrameAsync(Stream input)
    {
        var header = new byte[4];
        var read = await ReadExactlyOrEofAsync(input, header);
        if (read == 0) return null;
        if (read < 4) throw new EndOfStreamException("Truncated length header.");

        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is <= 0 or > MaxIncomingBytes) throw new InvalidDataException($"Bad message length {length}.");

        var body = new byte[length];
        if (await ReadExactlyOrEofAsync(input, body) < length) throw new EndOfStreamException("Truncated message.");
        return body;
    }

    private static async Task<int> ReadExactlyOrEofAsync(Stream input, byte[] buffer)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var n = await input.ReadAsync(buffer.AsMemory(total));
            if (n == 0) break;
            total += n;
        }
        return total;
    }

    private static async Task WriteFrameAsync(Stream output, byte[] json)
    {
        // Chrome rejects host->extension messages over 1 MB; trim the job list if we ever get close.
        if (json.Length > 1_000_000)
            json = Encoding.UTF8.GetBytes("{\"ok\":false,\"message\":\"Reply too large.\"}");

        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, json.Length);
        await output.WriteAsync(header);
        await output.WriteAsync(json);
        await output.FlushAsync();
    }
}
