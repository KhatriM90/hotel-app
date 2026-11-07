using System.Runtime.InteropServices;
using System.Text;

namespace YeaStay.LockBridge;

/// <summary>The card encoder on the reception desk.</summary>
public interface IEncoder
{
    string Mode { get; }

    /// <summary>Writes a guest card. 0 means success; anything else is the vendor's error number.</summary>
    int KeyCard(int comPort, KeyCardParams p);

    /// <summary>Reads the card on the encoder.</summary>
    ReadResult ReadCard(int comPort, ReadParams p);
}

/// <summary>
/// TEMIC20 "V20 RF" encoder through the vendor's HUNERF.dll (Lock DLL20.pdf).
/// The DLL is 32-bit and needs the vendor's Borland runtime files (the "List"
/// folder) beside it, so this process must be x86 and run from that folder.
/// Calls are made one at a time from the bridge's single loop.
/// </summary>
public sealed class HunerfEncoder : IEncoder
{
    private const string Dll = "hunerf.dll";

    public string Mode => "dll";

    [DllImport(Dll, EntryPoint = "KeyCard", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int NativeKeyCard(
        int com, int cardNo, int nBlock, int encrypt, string cardPass, string systemCode, string hotelCode, string pass,
        string address, string sdIn, string stIn, string sdOut, string stOut, int levelPass, int passMode, int addressMode,
        int addressQty, int timeMode, int v8, int v16, int v24, int alwaysOpen, int openBolt, int terminateOld, int validTimes);

    [DllImport(Dll, EntryPoint = "ReadMessage", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int NativeReadMessage(
        int com, int nBlock, int encrypt, out int cardNo, out int cardType, out int passLevel, string cardPass,
        StringBuilder systemCode, StringBuilder address, StringBuilder dateTime);

    public int KeyCard(int comPort, KeyCardParams p) =>
        NativeKeyCard(comPort, p.CardNo, p.NBlock, p.Encrypt, p.CardPass, p.SystemCode, p.HotelCode, p.RoomPass, p.Address,
            p.SdIn, p.StIn, p.SdOut, p.StOut, p.LevelPass, p.PassMode, p.AddressMode, p.AddressQty, p.TimeMode,
            p.V8, p.V16, p.V24, p.AlwaysOpen, p.OpenBolt, p.TerminateOld, p.ValidTimes);

    public ReadResult ReadCard(int comPort, ReadParams p)
    {
        // Buffers sized as in the vendor's PowerBuilder demo (16, 128, 18) with room to spare.
        var system = new StringBuilder(64);
        var address = new StringBuilder(256);
        var dateTime = new StringBuilder(64);
        var ret = NativeReadMessage(comPort, p.NBlock, p.Encrypt, out var cardNo, out _, out _, p.CardPass, system, address, dateTime);
        return new ReadResult(ret, cardNo, system.ToString().Trim());
    }
}

/// <summary>
/// Stand-in encoder for testing without the hardware: logs what would be
/// written. MOCK_FAIL_CODE makes every write fail with that number;
/// MOCK_READ_CARD_NO is the card number a read returns.
/// </summary>
public sealed class MockEncoder : IEncoder
{
    private readonly Action<string> _log;
    private readonly int _failCode;
    private readonly int _readCardNo;

    public MockEncoder(Action<string> log, int failCode = 0, int readCardNo = 1)
    {
        _log = log;
        _failCode = failCode;
        _readCardNo = readCardNo;
    }

    public string Mode => "mock";

    public List<(int ComPort, KeyCardParams Params)> Written { get; } = new();

    public int KeyCard(int comPort, KeyCardParams p)
    {
        _log($"[mock] COM{comPort}: card {p.CardNo} for lock {p.Address}, {(p.TerminateOld == 1 ? "new" : "duplicate")}, " +
             $"valid {p.SdIn} {p.StIn} to {p.SdOut} {p.StOut}");
        if (_failCode != 0) return _failCode;
        Written.Add((comPort, p));
        return 0;
    }

    public ReadResult ReadCard(int comPort, ReadParams p)
    {
        _log($"[mock] COM{comPort}: read card -> {_readCardNo}");
        return new ReadResult(_failCode, _failCode == 0 ? _readCardNo : 0, "");
    }
}
