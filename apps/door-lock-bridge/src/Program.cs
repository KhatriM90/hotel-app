using System.Reflection;
using System.Text.Json;
using YeaStay.LockBridge;

// YeaStay door-lock bridge. Settings come from appsettings.json next to the
// exe, overridden by YEASTAY_CLOUD_API_URL, YEASTAY_BRIDGE_TOKEN, YEASTAY_MODE,
// YEASTAY_BRIDGE_ID and YEASTAY_COM_PORT. The vendor's DLL looks for its
// support files in the current folder, so work from the exe's folder.
var baseDir = AppContext.BaseDirectory;
Directory.SetCurrentDirectory(baseDir);
var logDir = Path.Combine(baseDir, "logs");
Directory.CreateDirectory(logDir);
var logLock = new object();
void Log(string message)
{
    var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}";
    lock (logLock)
    {
        Console.WriteLine(line);
        try { File.AppendAllText(Path.Combine(logDir, $"bridge-{DateTime.Now:yyyyMMdd}.txt"), line + Environment.NewLine); } catch { }
    }
}

BridgeSettings settings;
try
{
    settings = BridgeSettings.Load(Path.Combine(baseDir, "appsettings.json"), Environment.GetEnvironmentVariable);
}
catch (Exception e)
{
    Log($"Settings problem: {e.Message}");
    return 2;
}

var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
IEncoder encoder = settings.Mode == "mock"
    ? new MockEncoder(Log, IntEnv("MOCK_FAIL_CODE"), Math.Max(1, IntEnv("MOCK_READ_CARD_NO")))
    : new HunerfEncoder();
if (settings.Mode == "dll" && Environment.Is64BitProcess)
{
    Log("hunerf.dll is 32-bit: use the win-x86 build of the bridge.");
    return 3;
}

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
using var http = new HttpClient();
var cloud = new HttpCloudQueue(http, settings.CloudApiUrl, settings.BridgeToken, settings.BridgeId, encoder.Mode, version);
await new Bridge(cloud, encoder, settings.BridgeId, settings.ComPortOverride, TimeSpan.FromMilliseconds(settings.PollMilliseconds), Log).RunAsync(cts.Token);
return 0;

static int IntEnv(string name) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : 0;

public sealed record BridgeSettings(string CloudApiUrl, string BridgeToken, string Mode, string BridgeId, int PollMilliseconds, int ComPortOverride)
{
    public static BridgeSettings Load(string path, Func<string, string?> env)
    {
        var file = File.Exists(path)
            ? JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(path)) ?? new()
            : new Dictionary<string, JsonElement>();
        string? Str(string key, string envName) =>
            env(envName) is { Length: > 0 } e ? e : file.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        int Int(string key, string envName, int fallback) =>
            int.TryParse(env(envName), out var e) ? e : file.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;

        var url = Str("CloudApiUrl", "YEASTAY_CLOUD_API_URL");
        var token = Str("BridgeToken", "YEASTAY_BRIDGE_TOKEN");
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw new InvalidOperationException("CloudApiUrl is missing, e.g. https://test.yeastay.example/api");
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Host is not ("localhost" or "127.0.0.1"))
            throw new InvalidOperationException("CloudApiUrl must use https");
        if (string.IsNullOrWhiteSpace(token) || token.Length < 20)
            throw new InvalidOperationException("BridgeToken is missing: pair this PC under Door locks in YeaStay");
        var mode = (Str("Mode", "YEASTAY_MODE") ?? "dll").ToLowerInvariant();
        if (mode is not ("dll" or "mock")) throw new InvalidOperationException("Mode is dll or mock");
        var id = Str("BridgeId", "YEASTAY_BRIDGE_ID");
        if (string.IsNullOrWhiteSpace(id)) id = Environment.MachineName;
        id = new string(id.Where(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-').ToArray());
        if (id.Length < 3) id = "reception-pc";
        if (id.Length > 64) id = id[..64];
        return new BridgeSettings(url, token, mode, id, Math.Clamp(Int("PollMilliseconds", "YEASTAY_POLL_MS", 1500), 500, 10000),
            Math.Clamp(Int("ComPortOverride", "YEASTAY_COM_PORT", 0), 0, 64));
    }
}
