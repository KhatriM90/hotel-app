using System.Net;
using System.Net.Sockets;
using Xunit;
using YeaStay.PosBridge;

namespace YeaStay.PosBridge.Tests;

public class StatusTests
{
    [Fact]
    public void Ready_printer_has_no_problem() => Assert.Null(NetworkPrinter.Describe(0x12, 0x12));

    [Fact]
    public void Cover_open_is_reported() => Assert.StartsWith("Cover open", NetworkPrinter.Describe(0x16, 0x12));

    [Fact]
    public void Paper_out_is_reported_from_either_byte()
    {
        Assert.StartsWith("Paper out", NetworkPrinter.Describe(0x12, 0x72));
        Assert.StartsWith("Paper out", NetworkPrinter.Describe(0x32, 0x12));
    }

    [Fact]
    public void Error_is_reported() => Assert.StartsWith("Printer error", NetworkPrinter.Describe(0x52, 0x12));

    [Fact]
    public void Bytes_that_are_not_status_are_ignored() => Assert.Null(NetworkPrinter.Describe(0xff, 0x00));
}

public class NetworkPrinterTests
{
    private static PrinterTarget Target(int port) => new("Kitchen printer", "network", "127.0.0.1", port, null);

    /// <summary>A fake Epson: answers the status request with the given bytes (or not at all) and keeps what it receives.</summary>
    private static async Task<byte[]> FakePrinter(TcpListener listener, byte[]? status)
    {
        using var client = await listener.AcceptTcpClientAsync();
        var stream = client.GetStream();
        var request = new byte[6];
        var got = 0;
        while (got < 6) got += await stream.ReadAsync(request.AsMemory(got));
        Assert.Equal(new byte[] { 0x10, 0x04, 0x02, 0x10, 0x04, 0x04 }, request);
        if (status is not null) await stream.WriteAsync(status);
        using var rest = new MemoryStream();
        await stream.CopyToAsync(rest);
        return rest.ToArray();
    }

    [Fact]
    public async Task Ready_printer_receives_the_job()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var server = FakePrinter(listener, new byte[] { 0x12, 0x12 });
        var data = new byte[] { 0x1b, 0x40, (byte)'H', (byte)'i', 0x0a };
        await new NetworkPrinter().PrintAsync(Target(port), data, CancellationToken.None);
        Assert.Equal(data, await server.WaitAsync(TimeSpan.FromSeconds(5)));
        listener.Stop();
    }

    [Fact]
    public async Task Printer_without_status_answer_still_prints()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var server = FakePrinter(listener, null);
        var data = new byte[] { 1, 2, 3 };
        await new NetworkPrinter(statusTimeout: TimeSpan.FromMilliseconds(200)).PrintAsync(Target(port), data, CancellationToken.None);
        Assert.Equal(data, await server.WaitAsync(TimeSpan.FromSeconds(5)));
        listener.Stop();
    }

    [Fact]
    public async Task Cover_open_fails_without_sending_the_job()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var server = FakePrinter(listener, new byte[] { 0x16, 0x12 });
        var e = await Assert.ThrowsAsync<PrinterException>(() => new NetworkPrinter().PrintAsync(Target(port), new byte[] { 9, 9 }, CancellationToken.None));
        Assert.Equal("Kitchen printer: Cover open. Close the printer cover, then reprint.", e.Message);
        Assert.Empty(await server.WaitAsync(TimeSpan.FromSeconds(5)));
        listener.Stop();
    }

    [Fact]
    public async Task Unreachable_printer_says_so()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop(); // nothing listening any more
        var e = await Assert.ThrowsAsync<PrinterException>(() =>
            new NetworkPrinter(TimeSpan.FromSeconds(2)).PrintAsync(Target(port), new byte[] { 1 }, CancellationToken.None));
        Assert.Contains("Cannot reach Kitchen printer", e.Message);
    }

    [Fact]
    public async Task Missing_address_is_reported()
    {
        var e = await Assert.ThrowsAsync<PrinterException>(() =>
            new NetworkPrinter().PrintAsync(new PrinterTarget("Bar", "network", null, 9100, null), new byte[] { 1 }, CancellationToken.None));
        Assert.Contains("no IP address", e.Message);
    }
}

public class BridgeTests
{
    private sealed class FakeCloud : ICloudQueue
    {
        public readonly Queue<PrintJob?> Jobs = new();
        public readonly List<(string Id, JobResult Result)> Reports = new();
        public int FailReports;

        public Task<ClaimResponse> ClaimAsync(CancellationToken ct) =>
            Task.FromResult(new ClaimResponse("KM", Jobs.Count > 0 ? Jobs.Dequeue() : null));

        public Task ReportAsync(string jobId, JobResult result, CancellationToken ct)
        {
            if (FailReports > 0)
            {
                FailReports--;
                throw new HttpRequestException("network down");
            }
            Reports.Add((jobId, result));
            return Task.CompletedTask;
        }
    }

    private sealed class FakePrinter(string? failWith = null) : IPrinterTransport
    {
        public readonly List<byte[]> Printed = new();
        public Task PrintAsync(PrinterTarget printer, byte[] data, CancellationToken ct)
        {
            if (failWith is not null) throw new PrinterException(failWith);
            Printed.Add(data);
            return Task.CompletedTask;
        }
    }

    private static PrintJob Job(string id, string payload = "G0BIaQo=") =>
        new(id, "Ticket KM-TKT-1", 1, payload, new PrinterTarget("Kitchen", "network", "10.0.0.5", 9100, null));

    private static Bridge Make(FakeCloud cloud, IPrinterTransport printer) => new(cloud, printer, "pc-1", TimeSpan.Zero, _ => { });

    [Fact]
    public async Task Nothing_to_do_returns_false()
    {
        Assert.False(await Make(new FakeCloud(), new FakePrinter()).StepAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Prints_and_reports_printed()
    {
        var cloud = new FakeCloud();
        cloud.Jobs.Enqueue(Job("j1"));
        var printer = new FakePrinter();
        Assert.True(await Make(cloud, printer).StepAsync(CancellationToken.None));
        Assert.Equal(new byte[] { 0x1b, 0x40, (byte)'H', (byte)'i', 0x0a }, Assert.Single(printer.Printed));
        var (id, result) = Assert.Single(cloud.Reports);
        Assert.Equal("j1", id);
        Assert.Equal("printed", result.Outcome);
        Assert.Equal("pc-1", result.BridgeId);
    }

    [Fact]
    public async Task Printer_problem_is_reported_as_failed()
    {
        var cloud = new FakeCloud();
        cloud.Jobs.Enqueue(Job("j2"));
        await Make(cloud, new FakePrinter("Kitchen: Paper out")).StepAsync(CancellationToken.None);
        var (_, result) = Assert.Single(cloud.Reports);
        Assert.Equal("failed", result.Outcome);
        Assert.Equal("Kitchen: Paper out", result.Error);
    }

    [Fact]
    public async Task Damaged_job_is_failed_without_printing()
    {
        var cloud = new FakeCloud();
        cloud.Jobs.Enqueue(Job("j3", "not base64!!"));
        var printer = new FakePrinter();
        await Make(cloud, printer).StepAsync(CancellationToken.None);
        Assert.Empty(printer.Printed);
        Assert.Equal("failed", Assert.Single(cloud.Reports).Result.Outcome);
    }

    [Fact]
    public async Task Unsent_report_is_sent_before_the_next_claim_and_the_job_is_not_printed_twice()
    {
        var cloud = new FakeCloud { FailReports = 1 };
        cloud.Jobs.Enqueue(Job("j4"));
        var printer = new FakePrinter();
        var bridge = Make(cloud, printer);
        await Assert.ThrowsAsync<HttpRequestException>(() => bridge.StepAsync(CancellationToken.None));
        Assert.Empty(cloud.Reports);
        Assert.False(await bridge.StepAsync(CancellationToken.None));
        Assert.Equal("j4", Assert.Single(cloud.Reports).Id);
        Assert.Single(printer.Printed);
    }

    [Fact]
    public async Task Router_rejects_unknown_connections()
    {
        var router = new PrinterRouter(new FakePrinter(), new FakePrinter());
        await Assert.ThrowsAsync<PrinterException>(() =>
            router.PrintAsync(new PrinterTarget("X", "bluetooth", null, 0, null), new byte[] { 1 }, CancellationToken.None));
    }

    [Fact]
    public async Task Mock_printer_saves_the_job_to_the_outbox()
    {
        var dir = Path.Combine(Path.GetTempPath(), "yeastay-outbox-" + Guid.NewGuid().ToString("N"));
        await new MockPrinter(dir, _ => { }).PrintAsync(new PrinterTarget("Main kitchen", "network", "x", 9100, null), new byte[] { 7, 8 }, CancellationToken.None);
        var file = Assert.Single(Directory.GetFiles(dir));
        Assert.EndsWith("-Main-kitchen.bin", file);
        Assert.Equal(new byte[] { 7, 8 }, File.ReadAllBytes(file));
        Directory.Delete(dir, true);
    }
}

public class SettingsTests
{
    private static string Write(string json)
    {
        var path = Path.Combine(Path.GetTempPath(), $"bridge-settings-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, json);
        return path;
    }

    private const string Token = "abcdefghijklmnopqrstuvwxyz0123456789";

    [Fact]
    public void Loads_the_file_with_defaults()
    {
        var s = BridgeSettings.Load(Write($"{{\"CloudApiUrl\":\"https://test.example/api\",\"BridgeToken\":\"{Token}\",\"BridgeId\":\"KM bar PC!\"}}"), _ => null);
        Assert.Equal("live", s.Mode);
        Assert.Equal("KMbarPC", s.BridgeId);
        Assert.Equal(1000, s.PollMilliseconds);
    }

    [Fact]
    public void Environment_overrides_the_file()
    {
        var env = new Dictionary<string, string> { ["YEASTAY_MODE"] = "MOCK", ["YEASTAY_POLL_MS"] = "50" };
        var s = BridgeSettings.Load(Write($"{{\"CloudApiUrl\":\"https://test.example/api\",\"BridgeToken\":\"{Token}\"}}"), k => env.GetValueOrDefault(k));
        Assert.Equal("mock", s.Mode);
        Assert.Equal(500, s.PollMilliseconds); // clamped
    }

    [Theory]
    [InlineData("{\"CloudApiUrl\":\"http://test.example/api\",\"BridgeToken\":\"" + Token + "\"}", "https")]
    [InlineData("{\"CloudApiUrl\":\"https://test.example/api\"}", "BridgeToken")]
    [InlineData("{\"CloudApiUrl\":\"https://test.example/api\",\"BridgeToken\":\"" + Token + "\",\"Mode\":\"fast\"}", "live or mock")]
    public void Bad_settings_are_explained(string json, string expected)
    {
        var e = Assert.Throws<InvalidOperationException>(() => BridgeSettings.Load(Write(json), _ => null));
        Assert.Contains(expected, e.Message);
    }

    [Fact]
    public void Plain_http_is_allowed_on_localhost()
    {
        var s = BridgeSettings.Load(Write($"{{\"CloudApiUrl\":\"http://localhost:3000/api\",\"BridgeToken\":\"{Token}\"}}"), _ => null);
        Assert.Equal("http://localhost:3000/api", s.CloudApiUrl);
    }
}
