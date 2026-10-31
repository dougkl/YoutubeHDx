using System.Text.Json;
using System.Text.Json.Serialization;

namespace YoutubeHDx.Core;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    /// <summary>Single-line variant for the pipe and native messaging protocols.</summary>
    public static readonly JsonSerializerOptions Compact = new(Options) { WriteIndented = false };
}
