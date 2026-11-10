using System.Text.Json.Serialization;

namespace YeaStay.PosBridge;

/// <summary>Where a job prints: an Epson on the network (raw TCP, port 9100) or a printer installed on this PC.</summary>
public sealed record PrinterTarget(string Name, string Connection, string? Host, int Port, string? WindowsName);

/// <summary>A print job as YeaStay hands it out. The bytes are ready-made ESC/POS.</summary>
public sealed record PrintJob(string Id, string Title, int Attempt, string PayloadBase64, PrinterTarget Printer);

public sealed record ClaimResponse(string Property, PrintJob? Job);

/// <summary>Body of POST pos-bridge/jobs/:id/result.</summary>
public sealed class JobResult
{
    public required string BridgeId { get; init; }
    public required string Outcome { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Error { get; init; }

    public static JobResult Printed(string bridgeId) => new() { BridgeId = bridgeId, Outcome = "printed" };
    public static JobResult Failed(string bridgeId, string error) => new() { BridgeId = bridgeId, Outcome = "failed", Error = error };
}

/// <summary>A printer problem staff can act on ("Paper out", "Cover open").</summary>
public sealed class PrinterException(string message) : Exception(message);
