using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace YeaStay.PosBridge;

public interface ICloudQueue
{
    Task<ClaimResponse> ClaimAsync(CancellationToken ct);
    Task ReportAsync(string jobId, JobResult result, CancellationToken ct);
}

public sealed class CloudAuthException(string message) : Exception(message);

/// <summary>
/// Talks to YeaStay over outbound HTTPS only: nothing on the hotel network has
/// to accept connections from the internet.
/// </summary>
public sealed class HttpCloudQueue : ICloudQueue
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly string _bridgeId;
    private readonly string _mode;
    private readonly string _version;

    public HttpCloudQueue(HttpClient http, string cloudApiUrl, string token, string bridgeId, string mode, string version)
    {
        _http = http;
        _http.BaseAddress = new Uri(cloudApiUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        _http.Timeout = TimeSpan.FromSeconds(20);
        _bridgeId = bridgeId;
        _mode = mode;
        _version = version;
    }

    public async Task<ClaimResponse> ClaimAsync(CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync("pos-bridge/claim", new { bridgeId = _bridgeId, version = _version, mode = _mode }, Json, ct);
        await EnsureOk(res, ct);
        return (await res.Content.ReadFromJsonAsync<ClaimResponse>(Json, ct))!;
    }

    public async Task ReportAsync(string jobId, JobResult result, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync($"pos-bridge/jobs/{jobId}/result", result, Json, ct);
        // 409: the job timed out on the server or was already reported. Nothing more to do.
        if (res.StatusCode == HttpStatusCode.Conflict) return;
        await EnsureOk(res, ct);
    }

    private static async Task EnsureOk(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        var body = await res.Content.ReadAsStringAsync(ct);
        if (res.StatusCode == HttpStatusCode.Unauthorized)
            throw new CloudAuthException("YeaStay refused the bridge token. Pair this PC again under Printers and update appsettings.json.");
        throw new HttpRequestException($"YeaStay answered {(int)res.StatusCode}: {body}");
    }
}
