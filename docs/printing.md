# Kitchen, bar and bill printing (INT-04)

Kahama staff meeting, 9 Nov 2026, item 2.4: kitchen tickets sometimes did not print and nobody knew. YeaStay now sends every kitchen or bar ticket, bill and receipt to an Epson printer through a small program on a PC at the property, the **YeaStay POS bridge**. Each job has a status, failures are retried, and a ticket that still does not print raises an alert on the waiter's and the station's screen.

## How it works

1. A waiter presses **Send**. YeaStay makes the ticket for each station (as before) and, when the station has a printer, a **print job** with the ticket already laid out as ESC/POS bytes (Epson's printer language). A bill or receipt goes to the outlet's receipt printer the same way.
2. The bridge asks YeaStay for the next job every second over outbound HTTPS (nothing on the hotel network accepts connections from the internet), sends the bytes to the printer and reports **printed** or **failed** with the reason.
3. Before printing on a network Epson, the bridge asks the printer for its status, so "Cover open" and "Paper out" are reported instead of the ticket disappearing.
4. A failed try is retried after 5, then 10 seconds. After **3 tries** the job fails. If the printer has a **backup printer**, the job is sent there once (the slip title says "(backup printer)").
5. A failed job shows as a **red alert** on the waiter tablets of that outlet and on the kitchen/bar station screen, with a beep, until someone presses **Print again** or **Done** (the order reached the kitchen another way). Each ticket on the station screen shows *Printed on …*, *Printing on …* or *Not printed on …*.
6. If the bridge stops (PC off, program closed, internet down at the property), a job nobody picked up within 60 seconds fails with "bridge not running", so staff see the alert. A job the bridge took but never answered counts as a failed try after 30 seconds.

A station or outlet with no printer assigned works as before: tickets show on the station screen and bills print from the tablet's browser.

Slips are plain ASCII on 80 mm (48 characters) or 58 mm (32 characters) paper: Epson models use different default code pages, so accented letters are simplified (é → e). Kitchen tickets print items in double size, with REPRINT and CANCEL banners in white on black. Bills say "UPDATED BILL" or "REPRINT #n - COPY" following the reprint rules (meeting item 2.2).

## Setting up a property (back office → Printers, needs `pos.printer.manage`: manager, area manager, owner, admin)

1. **Add printer** for each Epson: a short code, the name staff know it by, and either
   - **Network**: its IP address (fix it in the router so it does not change) and port 9100, or
   - **USB**: the Windows printer name exactly as on the print PC (Settings → Printers). Install Epson's driver; YeaStay sends raw bytes through it.
   
   Choose the paper width and, if there is one, a **backup printer** (for example the bar printer as backup for the kitchen).
2. Under **Which printer prints what**, choose the ticket printer for each kitchen and bar station and the bill/receipt printer for each outlet.
3. **Pair print PC.** The token is shown once, as the contents of `appsettings.json` for the bridge.
4. Press **Test print** on each printer and check the job list at the bottom of the page.

## Installing the bridge on the print PC

Build it (any OS with the .NET 8 SDK):

```bash
cd apps/pos-bridge
dotnet publish src -c Release -r win-x86 -p:PublishSingleFile=true -p:SelfContained=true -o publish/win-x86
```

On a PC at the property that stays switched on and is on the same network as the printers:

1. Make a folder, for example `C:\YeaStay\PosBridge`, and copy in `YeaStayPosBridge.exe`.
2. Save the `appsettings.json` from the pairing step in the same folder (`appsettings.example.json` shows every setting). `Mode` is `live` for printers and `mock` for testing without one.
3. Run `YeaStayPosBridge.exe`. It logs to the console and to `logs\bridge-YYYYMMDD.txt`. To start it with Windows, add a Task Scheduler task "At startup" that runs the exe with "Start in" set to the folder (or "At log on" for a PC that signs in automatically).
4. The Printers page shows the PC as **Online** within a few seconds.

Settings can also come from environment variables: `YEASTAY_CLOUD_API_URL`, `YEASTAY_BRIDGE_TOKEN`, `YEASTAY_MODE`, `YEASTAY_BRIDGE_ID`, `YEASTAY_POLL_MS`. In mock mode jobs are saved as `.bin` files in `outbox\`, and `MOCK_FAIL` makes every job fail with that message.

One bridge serves the whole property. Pairing again gives a new token and the old PC stops printing.

## Trying it without hardware

With the API running locally (see the README), as `km.manager` on the Printers page: add a network printer (any IP), assign it to a station and pair. Then:

```bash
cd apps/pos-bridge
YEASTAY_CLOUD_API_URL=http://localhost:3000/api YEASTAY_BRIDGE_TOKEN=<token> YEASTAY_MODE=mock dotnet run --project src
```

Send an order as `km.waiter`: the bridge saves the ticket in `src/bin/.../outbox`. To see the bytes as text: `cat -v <file>.bin`. Restart with `MOCK_FAIL="Paper out"` to see the retries, the backup printer and the red alert on the tablet.

A real Epson on the network can be tested the same way with `YEASTAY_MODE=live`.

## Tests

- `apps/api/src/pos/escpos.spec.ts`: ASCII text, wrapping, right-aligned amounts, ESC @ at the start and a cut at the end, REPRINT and CANCEL banners.
- `apps/api/test/pos-printing.e2e-spec.ts`: printer set-up and permissions, pairing and token scope, a ticket printed through the bridge, three tries then the backup printer and an alert, staff retry and ticket reprint, bills on the receipt printer, lease expiry and bridge offline, test print, the job list, unpairing.
- `apps/pos-bridge/tests` (`dotnet test apps/pos-bridge/tests`): Epson status decoding, a fake network printer (job received, cover open, no status answer, unreachable), the poll loop (printed, failed, damaged job, unsent result sent again without printing twice), the mock printer and settings checks.
- `apps/pwa/src/print-alerts.test.ts` and `apps/backoffice/src/pos/Printers.test.tsx`: alert and job wording.

## Not covered yet

- **No internet at the property means no printing.** The bridge takes jobs from YeaStay in the cloud, so while the property's internet is down, orders taken offline on the tablets (OPS-05) print when the connection returns. Printing straight from the tablet to the printer on the local network would need the tablets to reach the printers directly; to decide after the first weeks at Kahama.
- **TIMS fiscal receipts (INT-02)**: Tevin (K1, Kahama) and Incotex (Small World). The bridge is built so a fiscal device adapter can be added beside the printers once the vendors' integration documents arrive.
- Epson models at each outlet are not known yet; the status check uses the standard Epson TM commands (DLE EOT), which TM-T20, TM-T82, TM-T88 and TM-m30 models answer. A printer that does not answer still prints.
- Cash drawer kick on cash payments.
