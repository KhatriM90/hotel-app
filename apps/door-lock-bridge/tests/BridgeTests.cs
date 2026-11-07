using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;
using YeaStay.LockBridge;

public class BridgeTests
{
    private static KeyCardParams Card(int no = 7, int terminateOld = 1) => new(
        no, 4, 1, "82A094FFFFFF", "A1B2C3", "0042", "4ACEFA", "01010100100", "31-07-07", "15:41:00", "31-07-10", "10:15:00",
        3, 1, 0, 1, 0, 255, 255, 255, 0, 0, terminateOld, 255);

    private sealed class FakeQueue : ICloudQueue
    {
        public readonly Queue<ClaimResponse> Claims = new();
        public readonly List<(string Id, JobResult Result)> Reports = new();
        public int FailReports;
        public int ClaimCalls;

        public Task<ClaimResponse> ClaimAsync(CancellationToken ct)
        {
            ClaimCalls++;
            return Task.FromResult(Claims.Count > 0 ? Claims.Dequeue() : new ClaimResponse("KM", null, 3));
        }

        public Task ReportAsync(string jobId, JobResult result, CancellationToken ct)
        {
            if (FailReports > 0) { FailReports--; throw new HttpRequestException("network down"); }
            Reports.Add((jobId, result));
            return Task.CompletedTask;
        }
    }

    private static (Bridge, FakeQueue, MockEncoder) Make(int failCode = 0, int comOverride = 0)
    {
        var q = new FakeQueue();
        var enc = new MockEncoder(_ => { }, failCode, readCardNo: 42);
        return (new Bridge(q, enc, "KM-PC", comOverride, TimeSpan.FromMilliseconds(10), _ => { }), q, enc);
    }

    [Fact]
    public async Task Writes_a_card_on_the_property_com_port_and_reports_done()
    {
        var (bridge, q, enc) = Make();
        q.Claims.Enqueue(new ClaimResponse("KM", new BridgeJob("j1", "new", Card(), null), 3));
        Assert.True(await bridge.StepAsync(default));
        Assert.Equal(3, enc.Written.Single().ComPort);
        Assert.Equal("4ACEFA", enc.Written.Single().Params.RoomPass);
        Assert.Equal(("j1", "done"), (q.Reports.Single().Id, q.Reports.Single().Result.Outcome));
        Assert.False(await bridge.StepAsync(default));
    }

    [Fact]
    public async Task Uses_the_local_com_port_override()
    {
        var (bridge, q, enc) = Make(comOverride: 5);
        q.Claims.Enqueue(new ClaimResponse("KM", new BridgeJob("j1", "duplicate", Card(terminateOld: 0), null), 3));
        await bridge.StepAsync(default);
        Assert.Equal(5, enc.Written.Single().ComPort);
    }

    [Fact]
    public async Task Reports_the_encoder_error_number()
    {
        var (bridge, q, _) = Make(failCode: 3);
        q.Claims.Enqueue(new ClaimResponse("KM", new BridgeJob("j1", "new", Card(), null), 3));
        await bridge.StepAsync(default);
        var r = q.Reports.Single().Result;
        Assert.Equal("failed", r.Outcome);
        Assert.Equal(3, r.ErrorCode);
        Assert.Contains("COM3", r.Error);
    }

    [Fact]
    public async Task Resends_an_unsent_result_before_claiming_and_never_writes_twice()
    {
        var (bridge, q, enc) = Make();
        q.FailReports = 1;
        q.Claims.Enqueue(new ClaimResponse("KM", new BridgeJob("j1", "new", Card(), null), 3));
        await Assert.ThrowsAsync<HttpRequestException>(() => bridge.StepAsync(default));
        Assert.Empty(q.Reports);
        Assert.False(await bridge.StepAsync(default));
        Assert.Equal("j1", q.Reports.Single().Id);
        Assert.Single(enc.Written);
    }

    [Fact]
    public async Task Reads_a_card()
    {
        var (bridge, q, _) = Make();
        q.Claims.Enqueue(new ClaimResponse("KM", new BridgeJob("r1", "read", null, new ReadParams(4, 1, "82A094FFFFFF")), 3));
        await bridge.StepAsync(default);
        Assert.Equal(42, q.Reports.Single().Result.CardNo);
    }

    [Fact]
    public void Parses_the_claim_YeaStay_sends()
    {
        const string json = """
        {"property":"KM","comPort":3,"job":{"id":"0b6f","kind":"new","keyCard":{"cardNo":7,"nBlock":4,"encrypt":1,"cardPass":"82A094FFFFFF",
         "systemCode":"A1B2C3","hotelCode":"0042","roomPass":"4ACEFA","address":"01010100100","sdIn":"31-07-07","stIn":"15:41:00",
         "sdOut":"31-07-10","stOut":"10:15:00","levelPass":3,"passMode":1,"addressMode":0,"addressQty":1,"timeMode":0,"v8":255,"v16":255,
         "v24":255,"alwaysOpen":0,"openBolt":0,"terminateOld":1,"validTimes":255}}}
        """;
        var claim = JsonSerializer.Deserialize<ClaimResponse>(json, HttpCloudQueue.Json)!;
        Assert.Equal(Card(), claim.Job!.KeyCard);
        Assert.Null(JsonSerializer.Deserialize<ClaimResponse>("""{"property":"KM","comPort":1,"job":null}""", HttpCloudQueue.Json)!.Job);
    }

    [Fact]
    public void Leaves_empty_result_fields_out()
    {
        var s = JsonSerializer.Serialize(JobResult.Done("KM-PC"), HttpCloudQueue.Json);
        Assert.Equal("""{"bridgeId":"KM-PC","outcome":"done"}""", s);
    }

    [Fact]
    public async Task Talks_to_the_bridge_api_with_the_token()
    {
        var handler = new Recorder();
        var cloud = new HttpCloudQueue(new HttpClient(handler), "https://yeastay.test/api", "token-token-token-token", "KM-PC", "mock", "0.1.0");
        await cloud.ClaimAsync(default);
        Assert.Equal("https://yeastay.test/api/door-locks/bridge/claim", handler.Last!.RequestUri!.ToString());
        Assert.Equal("Bearer token-token-token-token", handler.Last.Headers.Authorization!.ToString());
        Assert.Contains("\"bridgeId\":\"KM-PC\"", handler.Body);
        handler.Status = HttpStatusCode.Conflict;
        await cloud.ReportAsync("j1", JobResult.Done("KM-PC"), default); // already reported: fine
        handler.Status = HttpStatusCode.Unauthorized;
        await Assert.ThrowsAsync<CloudAuthException>(() => cloud.ClaimAsync(default));
    }

    private sealed class Recorder : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        public string Body = "";
        public HttpStatusCode Status = HttpStatusCode.OK;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            Body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            return new HttpResponseMessage(Status) { Content = new StringContent("""{"property":"KM","comPort":1,"job":null}""", Encoding.UTF8, "application/json") };
        }
    }

    [Fact]
    public void Checks_its_settings()
    {
        string? None(string _) => null;
        var path = Path.Combine(Path.GetTempPath(), $"bridge-{Guid.NewGuid()}.json");
        File.WriteAllText(path, """{"CloudApiUrl":"http://yeastay.test/api","BridgeToken":"abcdefghijklmnopqrstuvwxyz"}""");
        try
        {
            Assert.Contains("https", Assert.Throws<InvalidOperationException>(() => BridgeSettings.Load(path, None)).Message);
            var s = BridgeSettings.Load(path, n => n == "YEASTAY_CLOUD_API_URL" ? "https://yeastay.test/api" : n == "YEASTAY_MODE" ? "mock" : null);
            Assert.Equal(("mock", 1500, 0), (s.Mode, s.PollMilliseconds, s.ComPortOverride));
            Assert.Throws<InvalidOperationException>(() => BridgeSettings.Load(path + ".missing", None));
        }
        finally { File.Delete(path); }
    }
}
