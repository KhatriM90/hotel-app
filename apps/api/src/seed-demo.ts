/**
 * Demo data: bookings, stays, folios and POS activity at all three properties,
 * dated around today, so every scenario in docs/how-to-test-reservations.md and
 * docs/how-to-test-pos.md can be shown without setting it up by hand.
 *
 *   API_URL=http://localhost:3000/api SEED_PASSWORD='...' node dist/seed-demo.js
 *
 * Run it after the normal seed, against a running API. It signs in as the
 * seeded users and calls the same routes as the back office and the tablets,
 * so numbering, prices, taxes, approvals and idempotency keys all apply
 * (brief §9). Nothing is written to the database directly and nothing
 * finalised is ever edited.
 *
 * Dates: if a property's business date is behind today (Africa/Nairobi), the
 * "arrived yesterday" guests are booked on that date and the demo closes the
 * day(s) up to today, which posts their room nights as the night audit does.
 * If the business date is already today, those guests arrive today instead
 * (set DEMO_HISTORY=on to close one day anyway; that moves the date forward).
 *
 * Re-running on the same business date does nothing for a property that
 * already has its demo (bookings carry the reference DEMO-<date>); set
 * DEMO_FORCE=1 to add another set. Every guest, booking and check is marked
 * "Demo data".
 *
 * Other settings: DEMO_PROPERTIES=K1,SW,KM (default all), DEMO_HISTORY=auto|on|off.
 */
import { addDays } from '@hotel/shared';
import { DemoApi } from './demo/api-client';
import { closeDay, DemoContext, PropertyCode, ScenarioResult } from './demo/context';
import { arrivePast, PLANS, present } from './demo/hotel-demo';
import { posDemo } from './demo/pos-demo';

export interface DemoOptions {
  apiUrl: string;
  password: string;
  properties?: PropertyCode[];
  history?: 'auto' | 'on' | 'off';
  force?: boolean;
  /** Today's date at the hotels; defaults to the clock in Africa/Nairobi. */
  today?: string;
  log?: (line: string) => void;
}

export interface DemoReport {
  results: ScenarioResult[];
  skipped: Array<{ property: PropertyCode; reason: string }>;
  dates: Partial<Record<PropertyCode, { from: string; to: string }>>;
}

export function nairobiToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function runDemo(opts: DemoOptions): Promise<DemoReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const api = new DemoApi(opts.apiUrl.replace(/\/$/, ''), opts.password);
  const owner = await api.as('owner');
  const clock = opts.today ?? nairobiToday();
  const report: DemoReport = { results: [], skipped: [], dates: {} };

  for (const code of opts.properties ?? (['K1', 'SW', 'KM'] as PropertyCode[])) {
    const base = `/properties/${code}`;
    const businessDate = async () => (await owner.get<{ currentBusinessDate: string }>(base)).currentBusinessDate;
    const start = await businessDate();
    log(`\n${code}: business date ${start}, today ${clock}`);

    // Earlier "arrivals" need a day close afterwards, which waits for POS days that have trading on them.
    let history = opts.history === 'on' || ((opts.history ?? 'auto') === 'auto' && start < clock);
    if (history) {
      const outlets = await owner.get<Array<{ name: string; dayDate: string | null }>>(`${base}/pos/outlets`);
      const open = outlets.filter((o) => o.dayDate && o.dayDate <= start);
      if (open.length) {
        log(`  ! POS days still open for ${start} (${open.map((o) => o.name).join(', ')}): guests arrive today instead of earlier`);
        history = false;
      }
    }
    const today = history ? (start < clock ? clock : addDays(start, 1)) : start;
    const marker = `DEMO-${today}`;

    const existing = await owner.get<unknown[]>(`${base}/reservations?q=${marker}`);
    if (existing.length && !opts.force) {
      const reason = `demo data for ${today} is already there (${existing.length} bookings with reference ${marker}); set DEMO_FORCE=1 to add more`;
      log(`  - skipped: ${reason}`);
      report.skipped.push({ property: code, reason });
      continue;
    }

    const ctx: DemoContext = { api, code, base, startDate: start, today, history, marker, results: report.results, log };
    const past = await arrivePast(ctx);

    if (history) {
      const manager = await api.as(PLANS[code].manager);
      for (let d = start; d < today; d = addDays(d, 1)) {
        try {
          const closed = await closeDay(ctx, manager, d);
          log(`  ✓ Business day ${closed.closedDate} closed by the manager (${closed.roomChargesPosted} room nights posted)`);
        } catch (err) {
          log(`  ✗ Could not close business day ${d}: ${(err as Error).message}`);
          break;
        }
      }
      ctx.today = await businessDate();
    }

    const hotel = await present(ctx, past);
    await posDemo(ctx, hotel);
    report.dates[code] = { from: start, to: ctx.today };
  }
  return report;
}

function printSummary(report: DemoReport): void {
  const ok = report.results.filter((r) => r.ok).length;
  const failed = report.results.filter((r) => !r.ok);
  console.log(`\nDemo data: ${ok} scenarios created, ${failed.length} failed, ${report.skipped.length} properties skipped.`);
  for (const f of failed) console.log(`  ✗ ${f.property} ${f.scenario}: ${f.detail}`);
  for (const [code, d] of Object.entries(report.dates)) {
    console.log(`  ${code}: business date ${d.from === d.to ? d.to : `${d.from} → ${d.to}`}`);
  }
}

if (require.main === module) {
  const password = process.env.SEED_PASSWORD;
  if (!password) {
    console.error('SEED_PASSWORD is required (the password the normal seed gave the demo users)');
    process.exit(1);
  }
  const properties = process.env.DEMO_PROPERTIES?.split(',').map((s) => s.trim().toUpperCase()) as PropertyCode[] | undefined;
  const history = (process.env.DEMO_HISTORY ?? 'auto') as 'auto' | 'on' | 'off';
  if (!['auto', 'on', 'off'].includes(history)) {
    console.error('DEMO_HISTORY must be auto, on or off');
    process.exit(1);
  }
  runDemo({
    apiUrl: process.env.API_URL ?? 'http://localhost:3000/api',
    password,
    properties,
    history,
    force: ['1', 'true'].includes(process.env.DEMO_FORCE ?? ''),
  })
    .then((report) => {
      printSummary(report);
      process.exit(report.results.some((r) => !r.ok) ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
