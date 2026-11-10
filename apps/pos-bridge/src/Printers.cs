using System.ComponentModel;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace YeaStay.PosBridge;

/// <summary>Sends ready-made ESC/POS bytes to one printer. Throws PrinterException with a message staff can act on.</summary>
public interface IPrinterTransport
{
    Task PrintAsync(PrinterTarget printer, byte[] data, CancellationToken ct);
}

/// <summary>Chooses network, Windows or mock printing per job.</summary>
public sealed class PrinterRouter(IPrinterTransport network, IPrinterTransport windows) : IPrinterTransport
{
    public Task PrintAsync(PrinterTarget printer, byte[] data, CancellationToken ct) => printer.Connection switch
    {
        "network" => network.PrintAsync(printer, data, ct),
        "windows" => windows.PrintAsync(printer, data, ct),
        _ => throw new PrinterException($"Unknown printer connection '{printer.Connection}'"),
    };
}

/// <summary>
/// An Epson TM printer on the network: raw ESC/POS on TCP port 9100. Before
/// printing it asks the printer for its real-time status (DLE EOT 2 and 4), so
/// "cover open" and "paper out" are reported instead of the job disappearing.
/// Printers that do not answer the status request still get the job.
/// </summary>
public sealed class NetworkPrinter(TimeSpan? connectTimeout = null, TimeSpan? statusTimeout = null) : IPrinterTransport
{
    private readonly TimeSpan _connect = connectTimeout ?? TimeSpan.FromSeconds(4);
    private readonly TimeSpan _status = statusTimeout ?? TimeSpan.FromMilliseconds(1500);

    public async Task PrintAsync(PrinterTarget printer, byte[] data, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(printer.Host)) throw new PrinterException($"{printer.Name} has no IP address in YeaStay");
        using var client = new TcpClient();
        using (var connect = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            connect.CancelAfter(_connect);
            try
            {
                await client.ConnectAsync(printer.Host, printer.Port, connect.Token);
            }
            catch (Exception e) when (e is OperationCanceledException or SocketException)
            {
                if (ct.IsCancellationRequested) throw;
                throw new PrinterException($"Cannot reach {printer.Name} at {printer.Host}:{printer.Port}. Check it is switched on and connected to the network.");
            }
        }
        var stream = client.GetStream();
        var problem = await CheckStatusAsync(stream, ct);
        if (problem is not null) throw new PrinterException($"{printer.Name}: {problem}");
        try
        {
            using var write = CancellationTokenSource.CreateLinkedTokenSource(ct);
            write.CancelAfter(TimeSpan.FromSeconds(15));
            await stream.WriteAsync(data, write.Token);
            await stream.FlushAsync(write.Token);
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or SocketException)
        {
            if (ct.IsCancellationRequested) throw;
            throw new PrinterException($"{printer.Name} stopped taking the job ({e.Message}).");
        }
    }

    /// <summary>Returns a problem to report, or null when the printer is ready or does not answer.</summary>
    internal async Task<string?> CheckStatusAsync(NetworkStream stream, CancellationToken ct)
    {
        await stream.WriteAsync(new byte[] { 0x10, 0x04, 0x02, 0x10, 0x04, 0x04 }, ct);
        var buf = new byte[2];
        var got = 0;
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
        wait.CancelAfter(_status);
        try
        {
            while (got < 2)
            {
                var n = await stream.ReadAsync(buf.AsMemory(got), wait.Token);
                if (n == 0) break;
                got += n;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // No status answer: some interfaces do not support it. Print anyway.
        }
        return got == 2 ? Describe(buf[0], buf[1]) : null;
    }

    /// <summary>Epson real-time status: n=2 offline cause, n=4 roll paper sensor. Bits 1 and 4 are always set, 0 and 7 always clear.</summary>
    internal static string? Describe(byte offlineCause, byte paper)
    {
        static bool Valid(byte b) => (b & 0x93) == 0x12;
        if (!Valid(offlineCause) || !Valid(paper)) return null;
        if ((offlineCause & 0x04) != 0) return "Cover open. Close the printer cover, then reprint.";
        if ((paper & 0x60) != 0 || (offlineCause & 0x20) != 0) return "Paper out. Load a new roll, then reprint.";
        if ((offlineCause & 0x40) != 0) return "Printer error (for example a paper jam or cutter error). Switch it off and on, then reprint.";
        return null;
    }
}

/// <summary>
/// A printer installed in Windows on this PC (for example an Epson on USB with
/// Epson's driver): the bytes go raw through the spooler, so the driver does not
/// change them.
/// </summary>
public sealed class WindowsRawPrinter : IPrinterTransport
{
    public Task PrintAsync(PrinterTarget printer, byte[] data, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows()) throw new PrinterException("Windows printers can only be used when the bridge runs on Windows");
        if (string.IsNullOrWhiteSpace(printer.WindowsName)) throw new PrinterException($"{printer.Name} has no Windows printer name in YeaStay");
        return Task.Run(() => Send(printer.WindowsName!, printer.Name, data), ct);
    }

    private static void Send(string windowsName, string label, byte[] data)
    {
        if (!OpenPrinter(windowsName, out var handle, IntPtr.Zero))
            throw new PrinterException($"Windows has no printer called \"{windowsName}\" ({new Win32Exception(Marshal.GetLastWin32Error()).Message}). Check the name under Settings > Printers.");
        try
        {
            var doc = new DOCINFOA { pDocName = "YeaStay", pDataType = "RAW" };
            if (StartDocPrinter(handle, 1, doc) == 0) throw new PrinterException($"{label}: Windows would not start the print job ({new Win32Exception(Marshal.GetLastWin32Error()).Message}).");
            try
            {
                if (!StartPagePrinter(handle)) throw new PrinterException($"{label}: Windows would not start the page.");
                var ptr = Marshal.AllocCoTaskMem(data.Length);
                try
                {
                    Marshal.Copy(data, 0, ptr, data.Length);
                    if (!WritePrinter(handle, ptr, data.Length, out var written) || written != data.Length)
                        throw new PrinterException($"{label}: Windows did not take the whole job ({new Win32Exception(Marshal.GetLastWin32Error()).Message}).");
                }
                finally
                {
                    Marshal.FreeCoTaskMem(ptr);
                    EndPagePrinter(handle);
                }
            }
            finally
            {
                EndDocPrinter(handle);
            }
        }
        finally
        {
            ClosePrinter(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private sealed class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string? pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string? pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string? pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    private static extern bool OpenPrinter(string printerName, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    private static extern int StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA doc);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr handle, IntPtr bytes, int count, out int written);
}

/// <summary>
/// For trying YeaStay without printers: each job is saved as a .bin file in
/// the outbox folder. MOCK_FAIL makes every job fail with that message.
/// </summary>
public sealed class MockPrinter(string outbox, Action<string> log, string? failWith = null) : IPrinterTransport
{
    public async Task PrintAsync(PrinterTarget printer, byte[] data, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(failWith)) throw new PrinterException($"{printer.Name}: {failWith}");
        Directory.CreateDirectory(outbox);
        var safe = new string(printer.Name.Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray());
        var path = Path.Combine(outbox, $"{DateTime.Now:yyyyMMdd-HHmmss-fff}-{safe}.bin");
        await File.WriteAllBytesAsync(path, data, ct);
        log($"(mock) {printer.Name}: {data.Length} bytes saved to {path}");
    }
}
