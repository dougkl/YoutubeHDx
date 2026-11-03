using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace YoutubeHDx.Core.Tidal;

public sealed record TidalTokens(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt, string? UserId);

/// <summary>
/// Sign-in with TIDAL's official OAuth (authorization code + PKCE): your browser shows TIDAL's own login and consent
/// page, and TIDAL sends the app a one-time code on http://localhost:51735/tidal-callback. No password ever passes
/// through the app. The tokens are kept in %LocalAppData%\YoutubeHDx, encrypted for your Windows user.
/// </summary>
public static class TidalAuth
{
    public const string AuthorizeUrl = "https://login.tidal.com/authorize";
    public const string TokenUrl = "https://auth.tidal.com/v1/oauth2/token";
    public const int CallbackPort = 51735;
    public const string RedirectUri = "http://localhost:51735/tidal-callback";
    public const string Scopes = "search.read playlists.read playlists.write user.read";

    public static string TokenFile => Path.Combine(AppPaths.DataDir, "tidal-token.bin");

    public sealed record Pkce(string Verifier, string Challenge, string State);

    public static Pkce NewPkce()
    {
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var verifier = B64(RandomNumberGenerator.GetBytes(48));
        return new Pkce(verifier, B64(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))), B64(RandomNumberGenerator.GetBytes(16)));
    }

    public static string BuildAuthorizeUrl(string clientId, Pkce pkce) =>
        AuthorizeUrl + "?response_type=code" +
        "&client_id=" + Uri.EscapeDataString(clientId) +
        "&redirect_uri=" + Uri.EscapeDataString(RedirectUri) +
        "&scope=" + Uri.EscapeDataString(Scopes) +
        "&code_challenge_method=S256&code_challenge=" + pkce.Challenge +
        "&state=" + pkce.State;

    /// <summary>
    /// Opens TIDAL's sign-in page (via <paramref name="openBrowser"/>) and waits for TIDAL's redirect to
    /// http://localhost:51735/tidal-callback. Some browsers (like the Claude desktop app's built-in one) won't open
    /// localhost: then the address that failed to open can be pasted instead (<paramref name="pastedRedirect"/>).
    /// </summary>
    public static async Task<TidalTokens> SignInAsync(HttpClient http, string clientId, Action<string> openBrowser, CancellationToken ct,
        Func<CancellationToken, Task<string?>>? pastedRedirect = null)
    {
        var pkce = NewPkce();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(15));
        var listeners = new List<TcpListener>();
        foreach (var address in new[] { IPAddress.Loopback, IPAddress.IPv6Loopback })
        {
            try { var l = new TcpListener(address, CallbackPort); l.Start(); listeners.Add(l); }
            catch (SocketException) { /* no IPv6, or the port is taken on one of them */ }
        }
        if (listeners.Count == 0 && pastedRedirect is null)
            throw new InvalidOperationException($"Port {CallbackPort} is in use; close whatever uses it and try again.");

        try
        {
            openBrowser(BuildAuthorizeUrl(clientId, pkce));
            var waits = listeners.Select(l => WaitForCallbackAsync(l, pkce.State, timeout.Token)).ToList();
            if (pastedRedirect is not null)
                waits.Add(Task.Run(async () =>
                {
                    var url = await pastedRedirect(timeout.Token).ConfigureAwait(false) ?? "";
                    var q = ParseQuery(url.Contains('?') ? url[(url.IndexOf('?') + 1)..] : url);
                    if (q.GetValueOrDefault("state") == pkce.State && (q.ContainsKey("code") || q.ContainsKey("error"))) return q;
                    await Task.Delay(Timeout.Infinite, timeout.Token).ConfigureAwait(false); // not a valid redirect: keep waiting for the real one
                    return q;
                }, timeout.Token));

            var first = await Task.WhenAny(waits).ConfigureAwait(false);
            var query = await first.ConfigureAwait(false);
            if (query.TryGetValue("error", out var error))
                throw new InvalidOperationException("TIDAL sign-in was not completed: " + (query.GetValueOrDefault("error_description") ?? error));
            var tokens = await ExchangeAsync(http, clientId, new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = query["code"],
                ["redirect_uri"] = RedirectUri,
                ["code_verifier"] = pkce.Verifier,
            }, null, ct).ConfigureAwait(false);
            Save(tokens);
            return tokens;
        }
        finally
        {
            timeout.Cancel();
            foreach (var l in listeners) l.Stop();
        }
    }

    private static async Task<Dictionary<string, string>> WaitForCallbackAsync(TcpListener listener, string state, CancellationToken ct)
    {
        while (true)
        {
            using var client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            await using var stream = client.GetStream();
            var requestLine = await ReadRequestLineAsync(stream, ct).ConfigureAwait(false);
            var target = requestLine.Split(' ') is { Length: >= 2 } p ? p[1] : "";
            if (!target.StartsWith("/tidal-callback", StringComparison.Ordinal))
            {
                await RespondAsync(stream, 404, "Not found").ConfigureAwait(false);
                continue;
            }
            var query = ParseQuery(target.Contains('?') ? target[(target.IndexOf('?') + 1)..] : "");
            if (query.GetValueOrDefault("state") != state)
            {
                await RespondAsync(stream, 400, "This sign-in link is out of date. Start the TIDAL sign-in again from YoutubeHDx.").ConfigureAwait(false);
                continue;
            }
            await RespondAsync(stream, 200, query.ContainsKey("error")
                ? "TIDAL sign-in was not completed. You can close this tab."
                : "Signed in to TIDAL. You can close this tab and go back to YoutubeHDx.").ConfigureAwait(false);
            return query;
        }
    }

    /// <summary>A valid access token: the saved one, refreshed when it's about to expire. Null if never signed in.</summary>
    public static async Task<TidalTokens?> GetValidAsync(HttpClient http, string clientId, CancellationToken ct)
    {
        var t = Load();
        if (t is null) return null;
        if (t.ExpiresAt > DateTimeOffset.Now.AddMinutes(2)) return t;
        var fresh = await ExchangeAsync(http, clientId, new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = t.RefreshToken,
        }, t.RefreshToken, ct).ConfigureAwait(false);
        Save(fresh);
        return fresh;
    }

    public static void SignOut()
    {
        if (File.Exists(TokenFile)) File.Delete(TokenFile);
    }

    private static async Task<TidalTokens> ExchangeAsync(HttpClient http, string clientId, Dictionary<string, string> form,
        string? previousRefresh, CancellationToken ct)
    {
        form["client_id"] = clientId;
        using var r = await http.PostAsync(TokenUrl, new FormUrlEncodedContent(form), ct).ConfigureAwait(false);
        var body = await r.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!r.IsSuccessStatusCode)
            throw new InvalidOperationException($"TIDAL sign-in failed ({(int)r.StatusCode}). Sign in again from YoutubeHDx. {Trim(body)}");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        string? Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var expires = root.TryGetProperty("expires_in", out var e) && e.TryGetInt32(out var secs) ? secs : 3600;
        var userId = root.TryGetProperty("user_id", out var u) ? u.ToString() : null;
        return new TidalTokens(Str("access_token") ?? throw new InvalidOperationException("TIDAL sent no access token."),
            Str("refresh_token") ?? previousRefresh ?? "", DateTimeOffset.Now.AddSeconds(expires), userId);
    }

    private static string Trim(string s) => s.Length > 200 ? s[..200] : s;

    private static async Task<string> ReadRequestLineAsync(NetworkStream stream, CancellationToken ct)
    {
        var buffer = new byte[8192];
        var sb = new StringBuilder();
        while (!sb.ToString().Contains("\r\n\r\n") && sb.Length < 16384)
        {
            var n = await stream.ReadAsync(buffer, ct).ConfigureAwait(false);
            if (n == 0) break;
            sb.Append(Encoding.ASCII.GetString(buffer, 0, n));
        }
        var text = sb.ToString();
        var end = text.IndexOf("\r\n", StringComparison.Ordinal);
        return end >= 0 ? text[..end] : text;
    }

    private static async Task RespondAsync(NetworkStream stream, int status, string message)
    {
        var html = "<!doctype html><meta charset=utf-8><title>YoutubeHDx</title><body style=\"font-family:sans-serif;padding:2em\"><p>" +
                   WebUtility.HtmlEncode(message) + "</p></body>";
        var bytes = Encoding.UTF8.GetBytes(html);
        var head = $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Error")}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head)).ConfigureAwait(false);
        await stream.WriteAsync(bytes).ConfigureAwait(false);
    }

    public static Dictionary<string, string> ParseQuery(string query)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var i = part.IndexOf('=');
            var k = Uri.UnescapeDataString((i < 0 ? part : part[..i]).Replace('+', ' '));
            var v = i < 0 ? "" : Uri.UnescapeDataString(part[(i + 1)..].Replace('+', ' '));
            d[k] = v;
        }
        return d;
    }

    // ---------------------------------------------------------------- token storage (DPAPI on Windows)

    private sealed record Stored([property: JsonPropertyName("a")] string A, [property: JsonPropertyName("r")] string R,
        [property: JsonPropertyName("e")] DateTimeOffset E, [property: JsonPropertyName("u")] string? U);

    public static void Save(TidalTokens t)
    {
        AppPaths.EnsureDataDir();
        var json = JsonSerializer.SerializeToUtf8Bytes(new Stored(t.AccessToken, t.RefreshToken, t.ExpiresAt, t.UserId));
        File.WriteAllBytes(TokenFile, OperatingSystem.IsWindows() ? Dpapi.Protect(json) : json);
    }

    public static TidalTokens? Load()
    {
        try
        {
            if (!File.Exists(TokenFile)) return null;
            var bytes = File.ReadAllBytes(TokenFile);
            var json = OperatingSystem.IsWindows() ? Dpapi.Unprotect(bytes) : bytes;
            var s = JsonSerializer.Deserialize<Stored>(json);
            return s is null ? null : new TidalTokens(s.A, s.R, s.E, s.U);
        }
        catch (Exception e) when (e is IOException or JsonException or CryptographicException)
        {
            return null;
        }
    }

    /// <summary>Windows Data Protection (CryptProtectData) for the current user, without extra packages.</summary>
    private static class Dpapi
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Blob { public int Size; public IntPtr Data; }

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr mem);

        public static byte[] Protect(byte[] data) => Run(data, true);
        public static byte[] Unprotect(byte[] data) => Run(data, false);

        private static byte[] Run(byte[] data, bool protect)
        {
            var handle = GCHandle.Alloc(data, GCHandleType.Pinned);
            try
            {
                var input = new Blob { Size = data.Length, Data = handle.AddrOfPinnedObject() };
                var ok = protect
                    ? CryptProtectData(ref input, "YoutubeHDx TIDAL", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out var output)
                    : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
                if (!ok) throw new CryptographicException(Marshal.GetLastWin32Error());
                try
                {
                    var result = new byte[output.Size];
                    Marshal.Copy(output.Data, result, 0, output.Size);
                    return result;
                }
                finally { LocalFree(output.Data); }
            }
            finally { handle.Free(); }
        }
    }
}
