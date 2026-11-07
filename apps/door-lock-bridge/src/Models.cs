using System.Text.Json.Serialization;

namespace YeaStay.LockBridge;

/// <summary>Every argument of HUNERF.dll KeyCard except the COM port, as YeaStay computed them.</summary>
public sealed record KeyCardParams(
    int CardNo,
    int NBlock,
    int Encrypt,
    string CardPass,
    string SystemCode,
    string HotelCode,
    string RoomPass,
    string Address,
    string SdIn,
    string StIn,
    string SdOut,
    string StOut,
    int LevelPass,
    int PassMode,
    int AddressMode,
    int AddressQty,
    int TimeMode,
    int V8,
    int V16,
    int V24,
    int AlwaysOpen,
    int OpenBolt,
    int TerminateOld,
    int ValidTimes);

public sealed record ReadParams(int NBlock, int Encrypt, string CardPass);

public sealed record BridgeJob(string Id, string Kind, KeyCardParams? KeyCard, ReadParams? Read);

public sealed record ClaimResponse(string Property, BridgeJob? Job, int ComPort);

public sealed record ReadResult(int ReturnCode, int CardNo, string SystemCode);

/// <summary>Body of POST door-locks/bridge/jobs/:id/result.</summary>
public sealed class JobResult
{
    public required string BridgeId { get; init; }
    public required string Outcome { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? CardNo { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? SystemCode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? ErrorCode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Error { get; init; }

    public static JobResult Done(string bridgeId, int? cardNo = null, string? systemCode = null) =>
        new() { BridgeId = bridgeId, Outcome = "done", CardNo = cardNo, SystemCode = systemCode };

    public static JobResult Failed(string bridgeId, string error, int? errorCode = null) =>
        new() { BridgeId = bridgeId, Outcome = "failed", Error = error, ErrorCode = errorCode };
}
