import { Permission } from '@hotel/shared';
import { PosReportsService } from '../pos/reports.service';
import { cashShiftsReport, flashReport, hotelReport, Meta, posSalesReport } from './builders';
import { FlashReportService } from './flash.service';
import { HotelReportsService } from './hotel-reports.service';
import { LedgerReportsService } from './ledger.service';
import { Report, Section } from './report';

/**
 * The report catalogue (RPT-06): one focused report per question, each a
 * single table (or a short set of related tables) that opens cleanly in Excel.
 * The back office lists these as cards; each card picks its own dates and
 * filter and downloads Excel or PDF. The full "pack" reports stay for anyone
 * who wants every table in one file.
 */

export type ReportArea = 'hotel' | 'pos' | 'money';
export type DateMode = 'range' | 'day' | 'none';

export interface CatalogContext {
  propertyId: string;
  businessDate: string;
  from: string;
  to: string;
  outletCode?: string;
  outletName: string | null;
  meta: Meta;
  hotel: HotelReportsService;
  pos: PosReportsService;
  flash: FlashReportService;
  ledger: LedgerReportsService;
}

export interface CatalogEntry {
  name: string;
  title: string;
  blurb: string;
  area: ReportArea;
  permission: Permission;
  dates: DateMode;
  /** Offer an outlet filter on the card. */
  outlet?: boolean;
  /** A pack of every table; listed last in its area. */
  pack?: boolean;
  build(ctx: CatalogContext): Promise<Report>;
}

const AMOUNTS = 'Amounts in KES.';

/** Keep only the named sections of a pack report, under a new key and title. */
function focus(pack: Report, name: string, title: string, sections: string[], extra: Partial<Report> = {}): Report {
  const picked: Section[] = sections.map((t) => {
    const s = pack.sections.find((x) => x.title === t);
    if (!s) throw new Error(`Section ${t} missing from ${pack.key}`);
    return s;
  });
  return { ...pack, key: name, title, sections: picked, ...extra };
}

const period = (from: string, to: string) => (from === to ? from : `${from} to ${to}`);

async function hotelPack(c: CatalogContext): Promise<Report> {
  return hotelReport(await c.hotel.report(c.propertyId, c.from, c.to), c.meta);
}

async function posPack(c: CatalogContext): Promise<Report> {
  const data = await c.pos.sales(c.propertyId, { from: c.from, to: c.to, outletCode: c.outletCode });
  return posSalesReport(data, c.meta, c.outletName);
}

const hotelFocus = (name: string, title: string, blurb: string, section: string, landscape = false): CatalogEntry => ({
  name,
  title,
  blurb,
  area: 'hotel',
  permission: 'report.read',
  dates: 'range',
  build: async (c) => focus(await hotelPack(c), name, title, [section], { landscape }),
});

const posFocus = (name: string, title: string, blurb: string, sections: string[], opts: { outlet?: boolean; notes?: string[] } = {}): CatalogEntry => ({
  name,
  title,
  blurb,
  area: 'pos',
  permission: 'pos.report',
  dates: 'range',
  outlet: opts.outlet ?? true,
  build: async (c) => {
    const pack = await posPack(c);
    return focus(pack, name, title, sections, opts.notes ? { notes: [...opts.notes, AMOUNTS] } : {});
  },
});

const REVENUE_ONCE = 'Revenue is counted once, from closed checks, by trading date. A room charge is a way of settling a bill, not a second sale; house accounts are not sales.';

export const CATALOG: CatalogEntry[] = [
  // Hotel (RPT-02, RPT-07) -----------------------------------------------------
  hotelFocus('room-sales', 'Daily room sales', 'Occupancy, rooms sold, room revenue, ADR and RevPAR for each business day, with arrivals, departures, cancellations and no-shows.', 'Daily room sales', true),
  hotelFocus('room-types', 'Room sales by room type', 'Rooms occupied and sold, room revenue and ADR per room type for the period.', 'By room type'),
  hotelFocus('booking-sources', 'Room sales by booking source', 'Walk-in, phone, email, agent and website business compared: rooms sold, revenue and ADR.', 'By booking source'),
  hotelFocus('cancellations', 'Cancellations', 'Every booking cancelled in the period, with booked value, any fee charged and the reason.', 'Cancellations', true),
  hotelFocus('no-shows', 'No-shows', 'Guests who did not arrive, by arrival date, with booked value and any fee charged.', 'No-shows', true),
  {
    name: 'daily-flash',
    title: 'Daily flash',
    blurb: 'One business day on one page: rooms, revenue, money received, cashier variances and exceptions.',
    area: 'hotel',
    permission: 'report.read',
    dates: 'day',
    build: async (c) => {
      const data = await c.flash.forProperty(c.propertyId, c.to);
      return { ...flashReport([data], null, c.to, c.meta), key: 'daily-flash' };
    },
  },
  {
    name: 'hotel-pack',
    title: 'Hotel report (all tables)',
    blurb: 'Daily room sales, room types, booking sources, cancellations and no-shows together in one file.',
    area: 'hotel',
    permission: 'report.read',
    dates: 'range',
    pack: true,
    build: hotelPack,
  },

  // Point of sale (RPT-03) -----------------------------------------------------
  posFocus('pos-summary', 'Sales summary', 'Gross to net sales, discounts, comps, tax by code and how bills were settled.', ['Summary', 'Tax', 'Settlement by payment method'], { notes: [REVENUE_ONCE] }),
  posFocus('pos-outlets', 'Sales by outlet', 'Checks and net sales for each outlet, side by side.', ['By outlet'], { outlet: false, notes: [REVENUE_ONCE] }),
  posFocus('pos-products', 'Sales by product', 'Quantity, discounts and net sales for every menu item sold.', ['By product']),
  posFocus('pos-categories', 'Sales by category', 'Quantity and net sales per menu category.', ['By category']),
  posFocus('pos-waiters', 'Sales by waiter', 'Checks closed and net sales per waiter.', ['By waiter']),
  {
    name: 'pos-discounts',
    title: 'Discounts and complimentaries',
    blurb: 'Every discounted or complimentary line: who, which item, list value, discount and the reason given.',
    area: 'pos',
    permission: 'pos.report',
    dates: 'range',
    outlet: true,
    build: async (c) => {
      const rows = await c.ledger.discounts(c.propertyId, c.from, c.to, c.outletCode);
      return {
        key: 'pos-discounts',
        title: 'Discounts and complimentaries',
        ...c.meta,
        period: period(c.from, c.to),
        filters: [`Outlet: ${c.outletName ?? 'All outlets'}`],
        landscape: true,
        sections: [
          {
            title: 'Discounts and complimentaries',
            columns: [
              { key: 'date', label: 'Date', kind: 'date' },
              { key: 'check', label: 'Check' },
              { key: 'outlet', label: 'Outlet' },
              { key: 'waiter', label: 'Waiter' },
              { key: 'item', label: 'Item' },
              { key: 'quantity', label: 'Qty', kind: 'number' },
              { key: 'listValue', label: 'List value', kind: 'money' },
              { key: 'priceRule', label: 'Happy hour / rule', kind: 'money' },
              { key: 'discount', label: 'Discount', kind: 'money' },
              { key: 'comp', label: 'Comp' },
              { key: 'reason', label: 'Reason' },
              { key: 'charged', label: 'Charged', kind: 'money' },
            ],
            rows: [...rows],
            totals: rows.length
              ? {
                  date: `Lines: ${rows.length}`,
                  listValue: sum(rows, 'listValue'),
                  priceRule: sum(rows, 'priceRule'),
                  discount: sum(rows, 'discount'),
                  charged: sum(rows, 'charged'),
                }
              : undefined,
          },
        ],
        notes: ['Closed checks only. A complimentary line is a 100% discount and is charged at 0.', AMOUNTS],
      };
    },
  },
  posFocus('pos-voids', 'Voids and waste', 'Checks voided with their reason, and lines cancelled before or wasted after preparation.', ['Voided checks', 'Corrections']),
  posFocus('pos-refunds', 'Refunds', 'Every POS refund with method, reason and who gave it.', ['Refunds']),
  posFocus('house-accounts', 'House accounts', 'Staff meals, entertainment and other house-account charges by cost centre. Not revenue.', ['House accounts (not revenue)']),
  {
    name: 'cash-shifts',
    title: 'Cash shifts and variances',
    blurb: 'Each cashier shift with float, expected and counted cash, variance and the manager review.',
    area: 'pos',
    permission: 'pos.report',
    dates: 'range',
    outlet: true,
    build: async (c) => {
      const rows = await c.pos.shifts(c.propertyId, { from: c.from, to: c.to, outletCode: c.outletCode });
      return cashShiftsReport(rows, c.from, c.to, c.meta, c.outletName);
    },
  },
  {
    name: 'pos-pack',
    title: 'POS sales (all tables)',
    blurb: 'Summary, tax, settlement, outlets, products, categories, waiters, voids and refunds in one file.',
    area: 'pos',
    permission: 'pos.report',
    dates: 'range',
    outlet: true,
    pack: true,
    build: posPack,
  },

  // Money and guest ledger (RPT-04) ---------------------------------------------
  {
    name: 'money-received',
    title: 'Money received',
    blurb: 'Cash, M-PESA, card and bank money taken each day at the front desk and the outlets, less refunds.',
    area: 'money',
    permission: 'report.read',
    dates: 'range',
    build: async (c) => {
      const rows = await c.ledger.moneyReceived(c.propertyId, c.from, c.to);
      return {
        key: 'money-received',
        title: 'Money received by day and method',
        ...c.meta,
        period: period(c.from, c.to),
        sections: [
          {
            title: 'Money received',
            columns: [
              { key: 'date', label: 'Date', kind: 'date' },
              { key: 'tender', label: 'Method' },
              { key: 'frontDesk', label: 'Front desk', kind: 'money' },
              { key: 'pos', label: 'POS', kind: 'money' },
              { key: 'refunds', label: 'POS refunds', kind: 'money' },
              { key: 'total', label: 'Total', kind: 'money' },
            ],
            rows: rows.map((r) => ({ ...r, tender: tenderLabel(r.tender) })),
            totals: rows.length
              ? { date: 'Total', frontDesk: sum(rows, 'frontDesk'), pos: sum(rows, 'pos'), refunds: sum(rows, 'refunds'), total: sum(rows, 'total') }
              : undefined,
          },
        ],
        notes: ['Confirmed folio payments and POS payments by business date, less POS refunds. A charge to a room is not money received; it is paid later on the folio.', AMOUNTS],
      };
    },
  },
  {
    name: 'guest-ledger',
    title: 'Guest ledger',
    blurb: 'Every open folio and every folio that still owes or is owed money, with charges, payments and balance, as of now.',
    area: 'money',
    permission: 'report.read',
    dates: 'none',
    build: async (c) => {
      const rows = await c.ledger.guestLedger(c.propertyId);
      return {
        key: 'guest-ledger',
        title: 'Guest ledger',
        ...c.meta,
        period: `As at ${c.businessDate}`,
        landscape: true,
        sections: [
          {
            title: 'Guest ledger',
            columns: [
              { key: 'folio', label: 'Folio' },
              { key: 'stay', label: 'Stay' },
              { key: 'guest', label: 'Guest' },
              { key: 'room', label: 'Room' },
              { key: 'arrival', label: 'Arrival', kind: 'date' },
              { key: 'departure', label: 'Departure', kind: 'date' },
              { key: 'stayStatus', label: 'Status' },
              { key: 'charges', label: 'Charges', kind: 'money' },
              { key: 'payments', label: 'Paid', kind: 'money' },
              { key: 'pending', label: 'Pending', kind: 'money' },
              { key: 'depositsUnapplied', label: 'Deposit held', kind: 'money' },
              { key: 'balance', label: 'Balance', kind: 'money' },
            ],
            rows: rows.map((r) => ({ ...r, stayStatus: tenderLabel(r.stayStatus) })),
            totals: rows.length
              ? { folio: `Folios: ${rows.length}`, charges: sum(rows, 'charges'), payments: sum(rows, 'payments'), pending: sum(rows, 'pending'), depositsUnapplied: sum(rows, 'depositsUnapplied'), balance: sum(rows, 'balance') }
              : undefined,
          },
        ],
        notes: [
          'Balance = posted charges less confirmed payments (deposits included). A negative balance is money owed back to the guest.',
          'Pending payments (e.g. M-PESA awaiting confirmation) are shown but not taken off the balance.',
          AMOUNTS,
        ],
      };
    },
  },
  {
    name: 'deposits-held',
    title: 'Deposits held',
    blurb: 'Deposits received and confirmed but not yet applied to a stay, by arrival date.',
    area: 'money',
    permission: 'report.read',
    dates: 'none',
    build: async (c) => {
      const rows = await c.ledger.depositsHeld(c.propertyId);
      return {
        key: 'deposits-held',
        title: 'Deposits held',
        ...c.meta,
        period: `As at ${c.businessDate}`,
        landscape: true,
        sections: [
          {
            title: 'Deposits held',
            columns: [
              { key: 'receipt', label: 'Receipt' },
              { key: 'receivedOn', label: 'Received', kind: 'date' },
              { key: 'booking', label: 'Booking' },
              { key: 'stay', label: 'Stay' },
              { key: 'guest', label: 'Guest' },
              { key: 'arrival', label: 'Arrival', kind: 'date' },
              { key: 'stayStatus', label: 'Status' },
              { key: 'tender', label: 'Method' },
              { key: 'reference', label: 'Reference' },
              { key: 'amount', label: 'Amount', kind: 'money' },
            ],
            rows: rows.map((r) => ({ ...r, tender: tenderLabel(r.tender), stayStatus: tenderLabel(r.stayStatus) })),
            totals: rows.length ? { receipt: `Deposits: ${rows.length}`, amount: sum(rows, 'amount') } : undefined,
          },
        ],
        notes: ['A deposit stays here until it is applied to the guest\'s bill at check-in or settlement.', AMOUNTS],
      };
    },
  },
];

export function catalogEntry(name: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.name === name);
}

/** Exact decimal sum of a money column (strings like "1234.50"). */
export function sum(rows: object[], key: string): string {
  const cents = rows.reduce((a, r) => a + Math.round(Number((r as Record<string, unknown>)[key] ?? 0) * 100), 0);
  return `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

function tenderLabel(s: string): string {
  if (s === 'mpesa') return 'M-PESA';
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
