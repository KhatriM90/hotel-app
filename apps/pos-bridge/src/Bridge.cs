namespace YeaStay.PosBridge;

/// <summary>
/// The poll loop: ask YeaStay for the next print job, send it to its printer,
/// report printed or failed. A result is reported exactly once; if the report
/// cannot be sent it is retried before anything else is claimed, so a ticket is
/// never printed twice by the bridge for the same job. YeaStay retries failed
/// jobs, moves them to a backup printer and alerts staff.
/// </summary>
public sealed class Bridge
{
    private readonly ICloudQueue _cloud;
    private readonly IPrinterTransport _printers;
    private readonly string _bridgeId;
    private readonly TimeSpan _idle;
    private readonly Action<string> _log;
    private (string JobId, JobResult Result)? _unsent;

    public Bridge(ICloudQueue cloud, IPrinterTransport printers, string bridgeId, TimeSpan idle, Action<string> log)
    {
        _cloud = cloud;
        _printers = printers;
        _bridgeId = bridgeId;
        _idle = idle;
        _log = log;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);
        _log($"YeaStay POS bridge started (bridge id {_bridgeId}).");
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var worked = await StepAsync(ct);
                backoff = TimeSpan.FromSeconds(2);
                if (!worked) await Task.Delay(_idle, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (CloudAuthException e)
            {
                _log(e.Message);
                await Delay(TimeSpan.FromSeconds(60), ct);
            }
            catch (Exception e)
            {
                _log($"Cannot reach YeaStay ({e.Message}); trying again in {backoff.TotalSeconds:0}s.");
                await Delay(backoff, ct);
                backoff = TimeSpan.FromSeconds(Math.Min(30, backoff.TotalSeconds * 2));
            }
        }
        _log("YeaStay POS bridge stopped.");
    }

    private static async Task Delay(TimeSpan t, CancellationToken ct)
    {
        try { await Task.Delay(t, ct); } catch (OperationCanceledException) { }
    }

    /// <summary>One round. Returns true when a job was handled (so poll again at once).</summary>
    public async Task<bool> StepAsync(CancellationToken ct)
    {
        if (_unsent is { } pending)
        {
            await _cloud.ReportAsync(pending.JobId, pending.Result, ct);
            _unsent = null;
        }
        var claim = await _cloud.ClaimAsync(ct);
        if (claim.Job is null) return false;
        var job = claim.Job;
        var result = await PrintAsync(job, ct);
        _unsent = (job.Id, result);
        await _cloud.ReportAsync(job.Id, result, ct);
        _unsent = null;
        return true;
    }

    internal async Task<JobResult> PrintAsync(PrintJob job, CancellationToken ct)
    {
        byte[] data;
        try
        {
            data = Convert.FromBase64String(job.PayloadBase64);
        }
        catch (FormatException)
        {
            return JobResult.Failed(_bridgeId, "The print job from YeaStay was damaged.");
        }
        try
        {
            await _printers.PrintAsync(job.Printer, data, ct);
            _log($"Printed {job.Title} on {job.Printer.Name}.");
            return JobResult.Printed(_bridgeId);
        }
        catch (PrinterException e)
        {
            _log($"Not printed: {job.Title} on {job.Printer.Name} (try {job.Attempt}): {e.Message}");
            return JobResult.Failed(_bridgeId, e.Message);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _log($"Printing crashed: {job.Title}: {e}");
            return JobResult.Failed(_bridgeId, $"Printing failed on {job.Printer.Name}: {e.Message}");
        }
    }
}
