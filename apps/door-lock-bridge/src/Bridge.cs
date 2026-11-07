namespace YeaStay.LockBridge;

/// <summary>
/// The poll loop: ask YeaStay for the next card, write it on the encoder,
/// report the result. One job at a time, because there is one encoder.
/// A job is reported exactly once; if the report cannot be sent it is retried
/// before anything else is claimed, so a card is never written twice by the
/// bridge for the same job.
/// </summary>
public sealed class Bridge
{
    private readonly ICloudQueue _cloud;
    private readonly IEncoder _encoder;
    private readonly string _bridgeId;
    private readonly int _comPortOverride;
    private readonly TimeSpan _idle;
    private readonly Action<string> _log;
    private (string JobId, JobResult Result)? _unsent;

    public Bridge(ICloudQueue cloud, IEncoder encoder, string bridgeId, int comPortOverride, TimeSpan idle, Action<string> log)
    {
        _cloud = cloud;
        _encoder = encoder;
        _bridgeId = bridgeId;
        _comPortOverride = comPortOverride;
        _idle = idle;
        _log = log;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);
        _log($"YeaStay lock bridge started ({_encoder.Mode} mode, bridge id {_bridgeId}).");
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
        _log("YeaStay lock bridge stopped.");
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
        var com = _comPortOverride > 0 ? _comPortOverride : claim.ComPort;
        var result = Encode(job, com);
        _unsent = (job.Id, result);
        await _cloud.ReportAsync(job.Id, result, ct);
        _unsent = null;
        return true;
    }

    internal JobResult Encode(BridgeJob job, int com)
    {
        try
        {
            if (job.Kind == "read")
            {
                if (job.Read is null) return JobResult.Failed(_bridgeId, "Read job without parameters");
                var r = _encoder.ReadCard(com, job.Read);
                _log(r.ReturnCode == 0 ? $"Read card {r.CardNo}." : $"Read failed, encoder error {r.ReturnCode}.");
                return r.ReturnCode == 0
                    ? JobResult.Done(_bridgeId, r.CardNo, r.SystemCode)
                    : JobResult.Failed(_bridgeId, Describe(r.ReturnCode, com), r.ReturnCode);
            }
            if (job.KeyCard is null) return JobResult.Failed(_bridgeId, "Card job without parameters");
            var ret = _encoder.KeyCard(com, job.KeyCard);
            _log(ret == 0
                ? $"Wrote {job.Kind} card {job.KeyCard.CardNo} for lock {job.KeyCard.Address}."
                : $"Card {job.KeyCard.CardNo} failed, encoder error {ret}.");
            return ret == 0 ? JobResult.Done(_bridgeId) : JobResult.Failed(_bridgeId, Describe(ret, com), ret);
        }
        catch (DllNotFoundException e)
        {
            return JobResult.Failed(_bridgeId, $"hunerf.dll or its support files are missing next to the bridge: {e.Message}");
        }
        catch (BadImageFormatException)
        {
            return JobResult.Failed(_bridgeId, "hunerf.dll is 32-bit; run the win-x86 build of the bridge");
        }
        catch (Exception e)
        {
            return JobResult.Failed(_bridgeId, $"Encoder call crashed: {e.Message}");
        }
    }

    /// <summary>The vendor has not documented its error numbers yet; say what to check.</summary>
    private static string Describe(int code, int com) =>
        $"The encoder returned error {code}. Check there is one card on the encoder and that it is connected on COM{com}, then try again.";
}
