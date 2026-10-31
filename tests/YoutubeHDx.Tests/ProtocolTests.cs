using System.Buffers.Binary;
using System.Diagnostics;
using System.Text.Json;
using YoutubeHDx.Core;

namespace YoutubeHDx.Tests;

internal static class IpcTests
{
    [Test]
    public static async Task RequestAndResponseRoundTrip()
    {
        IpcRequest? seen = null;
        using var server = new IpcServer(r =>
        {
            seen = r;
            return new IpcResponse(true, "hi", new[]
            {
                new JobSnapshot(Guid.NewGuid(), r.Url!, JobStatus.CompletedWithErrors, "T", 42.5, null, null, 3, null, "e", "x", DateTimeOffset.Now),
            });
        }, _ => { });
        server.Start();

        var reply = await IpcClient.SendAsync(new IpcRequest("enqueue", "https://youtu.be/x", NoPlaylist: true), 3000);

        Assert.Equal("enqueue", seen!.Command);
        Assert.True(seen.NoPlaylist);
        Assert.True(reply.Ok);
        Assert.Equal("hi", reply.Message);
        Assert.Equal(JobStatus.CompletedWithErrors, reply.Jobs![0].Status);
        Assert.Equal(42.5, reply.Jobs[0].Percent);
    }

    [Test]
    public static async Task HandlerExceptionsBecomeErrorReplies()
    {
        using var server = new IpcServer(_ => throw new ArgumentException("Not a valid URL: x"), _ => { });
        server.Start();
        var reply = await IpcClient.SendAsync(new IpcRequest("enqueue", "x"), 3000);
        Assert.False(reply.Ok);
        Assert.Contains("Not a valid URL", reply.Message!);
    }

    [Test]
    public static async Task ClientTimesOutWhenAppIsNotRunning()
    {
        try
        {
            await IpcClient.SendAsync(new IpcRequest("ping"), 300);
            throw new AssertException("Expected TimeoutException");
        }
        catch (TimeoutException) { /* expected */ }
    }

    [Test]
    public static void StatusSerializesAsCamelCaseForTheExtension()
    {
        var json = JsonSerializer.Serialize(new IpcResponse(true, Jobs: new[]
        {
            new JobSnapshot(Guid.Empty, "u", JobStatus.CompletedWithErrors, null, 1, null, null, 2, null, null, "s", DateTimeOffset.Now),
        }), Json.Compact);
        Assert.Contains("\"status\":\"completedWithErrors\"", json);
        Assert.Contains("\"itemsCompleted\":2", json);
        Assert.Contains("\"ok\":true", json);
    }
}

/// <summary>Starts the real native host process and speaks Chrome's framing to it.</summary>
internal static class NativeHostTests
{
    private static async Task<List<JsonElement>> Exchange(params byte[][] frames)
    {
        var dll = Path.Combine(AppContext.BaseDirectory, "YoutubeHDx.NativeHost.dll");
        var psi = new ProcessStartInfo("dotnet")
        {
            ArgumentList = { dll },
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        // Same sandboxed data folder as this process.
        psi.Environment[AppPaths.DataDirOverrideVariable] = AppPaths.DataDir;

        using var p = Process.Start(psi)!;
        var stdin = p.StandardInput.BaseStream;
        foreach (var f in frames) await stdin.WriteAsync(f);
        stdin.Close();

        using var ms = new MemoryStream();
        await p.StandardOutput.BaseStream.CopyToAsync(ms);
        await p.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));

        var bytes = ms.ToArray();
        var replies = new List<JsonElement>();
        for (var i = 0; i < bytes.Length;)
        {
            var len = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(i));
            replies.Add(JsonDocument.Parse(bytes.AsMemory(i + 4, len)).RootElement.Clone());
            i += 4 + len;
        }
        return replies;
    }

    private static byte[] Frame(object message)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(message);
        var frame = new byte[4 + json.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, json.Length);
        json.CopyTo(frame, 4);
        return frame;
    }

    [Test]
    public static async Task AnswersEveryMessageInOrder()
    {
        var replies = await Exchange(
            Frame(new { type = "ping" }),
            Frame(new { type = "nope" }),
            Frame(new { type = "status" }));

        Assert.Equal(3, replies.Count);
        Assert.Equal("Host OK.", replies[0].GetProperty("message").GetString());
        Assert.Contains("Unknown message type", replies[1].GetProperty("message").GetString()!);
        Assert.False(replies[2].GetProperty("ok").GetBoolean()); // status never auto-starts the app
        Assert.Contains("not running", replies[2].GetProperty("message").GetString()!);
    }

    [Test]
    public static async Task SavesCookiesFromTheExtension()
    {
        if (File.Exists(AppPaths.CookiesFile)) File.Delete(AppPaths.CookiesFile);
        var replies = await Exchange(Frame(new
        {
            type = "cookies",
            cookies = new[]
            {
                new { domain = ".youtube.com", hostOnly = false, path = "/", secure = true, httpOnly = true, session = false, expirationDate = 1800000000.5, name = "LOGIN_INFO", value = "secret" },
            },
        }));

        Assert.True(replies[0].GetProperty("ok").GetBoolean());
        Assert.Contains("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1800000000\tLOGIN_INFO\tsecret", File.ReadAllText(AppPaths.CookiesFile));
    }

    [Test]
    public static async Task DownloadWithoutUrlIsRejected()
    {
        var replies = await Exchange(Frame(new { type = "download" }));
        Assert.False(replies[0].GetProperty("ok").GetBoolean());
        Assert.Equal("Missing URL.", replies[0].GetProperty("message").GetString());
    }

    [Test]
    public static async Task BadFrameLengthEndsCleanlyWithoutGarbage()
    {
        var bogus = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(bogus, 50 * 1024 * 1024); // over the 4 MB limit
        var replies = await Exchange(Frame(new { type = "ping" }), bogus);
        Assert.Equal(1, replies.Count); // ping answered, then the host exits instead of reading 50 MB
    }

    [Test]
    public static async Task HandlesUnicodePayloads()
    {
        var replies = await Exchange(Frame(new { type = "nöpe-✓" }));
        Assert.Contains("nöpe-✓", replies[0].GetProperty("message").GetString()!);
    }
}
