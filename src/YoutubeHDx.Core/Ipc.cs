using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace YoutubeHDx.Core;

/// <summary>Commands: ping, enqueue, status, cancel, watch.</summary>
public sealed record IpcRequest(string Command, string? Url = null, bool NoPlaylist = false, Guid? JobId = null);

public sealed record IpcResponse(bool Ok, string? Message = null, IReadOnlyList<JobSnapshot>? Jobs = null);

/// <summary>Line-delimited JSON over a per-user named pipe: one request, one response, then close.</summary>
public sealed class IpcServer : IDisposable
{
    private static readonly UTF8Encoding Utf8 = new(false);
    private readonly Func<IpcRequest, IpcResponse> _handler;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _stop = new();
    private Task _acceptLoop = Task.CompletedTask;

    public IpcServer(Func<IpcRequest, IpcResponse> handler, Action<string> log)
    {
        _handler = handler;
        _log = log;
    }

    public void Start() => _acceptLoop = AcceptLoopAsync();

    private async Task AcceptLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            NamedPipeServerStream? server = null;
            try
            {
                server = new NamedPipeServerStream(
                    AppPaths.PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(_stop.Token).ConfigureAwait(false);
                var connected = server;
                server = null;
                _ = HandleAsync(connected);
            }
            catch (OperationCanceledException)
            {
                server?.Dispose();
                return;
            }
            catch (Exception ex)
            {
                server?.Dispose();
                _log($"IPC accept failed: {ex.Message}");
                await Task.Delay(1000).ConfigureAwait(false);
            }
        }
    }

    private async Task HandleAsync(NamedPipeServerStream pipe)
    {
        await using (pipe)
        {
            try
            {
                using var reader = new StreamReader(pipe, Utf8, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, Utf8, leaveOpen: true) { AutoFlush = true };

                var line = await reader.ReadLineAsync(_stop.Token).ConfigureAwait(false);
                IpcResponse response;
                try
                {
                    var request = line is null ? null : JsonSerializer.Deserialize<IpcRequest>(line, Json.Compact);
                    response = request is null ? new IpcResponse(false, "Empty request.") : _handler(request);
                }
                catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException)
                {
                    response = new IpcResponse(false, ex.Message);
                }

                await writer.WriteLineAsync(JsonSerializer.Serialize(response, Json.Compact)).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException)
            {
                // client went away or we're shutting down
            }
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        // Wait for the listening pipe to actually close, so the name is free (or cleanly refused) when we return.
        try { _acceptLoop.Wait(TimeSpan.FromSeconds(2)); } catch (AggregateException) { /* logged in the loop */ }
        _stop.Dispose();
    }
}

public static class IpcClient
{
    private static readonly UTF8Encoding Utf8 = new(false);

    /// <exception cref="TimeoutException">The app isn't running (nothing listening on the pipe).</exception>
    public static async Task<IpcResponse> SendAsync(IpcRequest request, int connectTimeoutMs, CancellationToken ct = default)
    {
        await using var pipe = new NamedPipeClientStream(
            ".", AppPaths.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(connectTimeoutMs, ct).ConfigureAwait(false);

        using var reader = new StreamReader(pipe, Utf8, leaveOpen: true);
        await using var writer = new StreamWriter(pipe, Utf8, leaveOpen: true) { AutoFlush = true };

        await writer.WriteLineAsync(JsonSerializer.Serialize(request, Json.Compact)).ConfigureAwait(false);
        var line = await reader.ReadLineAsync(ct).ConfigureAwait(false)
                   ?? throw new IOException("YoutubeHDx app closed the connection without replying.");
        return JsonSerializer.Deserialize<IpcResponse>(line, Json.Compact)
               ?? throw new IOException("YoutubeHDx app sent an empty reply.");
    }
}
