using System.Reflection;
using System.Text.Json;
using YeaStay.PosBridge;

// YeaStay POS bridge. Settings come from appsettings.json next to the exe,
// overridden by YEASTAY_CLOUD_API_URL, YEASTAY_BRIDGE_TOKEN, YEASTAY_MODE,
// YEASTAY_BRIDGE_ID and YEASTAY_POLL_MS.
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
IPrinterTransport printers = settings.Mode == "mock"
    ? new MockPrinter(Path.Combine(baseDir, "outbox"), Log, Environment.GetEnvironmentVariable("MOCK_FAIL"))
    : new PrinterRouter(new NetworkPrinter(), new WindowsRawPrinter());

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
using var http = new HttpClient();
var cloud = new HttpCloudQueue(http, settings.CloudApiUrl, settings.BridgeToken, settings.BridgeId, settings.Mode, version);
await new Bridge(cloud, printers, settings.BridgeId, TimeSpan.FromMilliseconds(settings.PollMilliseconds), Log).RunAsync(cts.Token);
return 0;

public sealed record BridgeSettings(string CloudApiUrl, string BridgeToken, string Mode, string BridgeId, int PollMilliseconds)
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
            throw new InvalidOperationException("BridgeToken is missing: pair this PC under Printers in YeaStay");
        var mode = (Str("Mode", "YEASTAY_MODE") ?? "live").ToLowerInvariant();
        if (mode is not ("live" or "mock")) throw new InvalidOperationException("Mode is live or mock");
        var id = Str("BridgeId", "YEASTAY_BRIDGE_ID");
        if (string.IsNullOrWhiteSpace(id)) id = Environment.MachineName;
        id = new string(id.Where(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-').ToArray());
        if (id.Length < 3) id = "pos-bridge-pc";
        if (id.Length > 64) id = id[..64];
        return new BridgeSettings(url, token, mode, id, Math.Clamp(Int("PollMilliseconds", "YEASTAY_POLL_MS", 1000), 500, 10000));
    }
}
