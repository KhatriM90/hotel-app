import { Money } from '@hotel/shared';
import { Report, Section, keyValueSection } from './report';
import { HOTEL_DEFINITIONS } from './hotel-reports.service';
import type { FlashProperty } from './flash.service';

/**
 * Turns report data into tables (RPT-06). The screens show the same data from
 * the JSON endpoints; these builders decide the columns of the CSV and PDF.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Meta {
  scope: string;
  generatedBy: string | null;
  generatedAt: string;
}

const label = (s: unknown) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const neg = (v: unknown) => Money.of(String(v ?? '0')).negate().toString();
const period = (from: string, to: string) => (from === to ? from : `${from} to ${to}`);

/** Gross to net, taxes, settlements and controls: shared by the sales report and the Z report. */
function posTotalsSections(t: Json): Section[] {
  return [
    keyValueSection('Summary', [
      ['Checks closed', t.checks?.closed ?? 0, 'number'],
      ['Checks voided', t.checks?.void ?? 0, 'number'],
      ['Checks still open', t.checks?.open ?? 0, 'number'],
      ['Covers', t.checks?.covers ?? 0, 'number'],
      ['Gross sales', t.grossSales],
      ['Happy hour and price rules', neg(t.ruleDiscounts)],
      ['Discounts', neg(t.discounts)],
      ['Complimentary', neg(t.comps)],
      ['Net sales (incl. tax)', t.netSales],
      ['Net of tax', t.netExTax],
      ['Tax', t.tax],
      ['Refunds', neg(t.refunds?.total)],
      ['Net after refunds', t.netAfterRefunds],
      ['House accounts (not revenue)', t.houseAccounts?.total],
    ]),
    {
      title: 'Tax',
      columns: [
        { key: 'code', label: 'Tax code' },
        { key: 'rate', label: 'Rate', kind: 'percent' },
        { key: 'taxable', label: 'Taxable', kind: 'money' },
        { key: 'tax', label: 'Tax', kind: 'money' },
      ],
      rows: (t.taxes ?? []).map((x: Json) => ({ code: `${x.taxCode} ${x.name ?? ''}`.trim(), rate: x.ratePercent, taxable: x.taxableAmount, tax: x.taxAmount })),
    },
    {
      title: 'Settlement by payment method',
      columns: [
        { key: 'method', label: 'Method' },
        { key: 'count', label: 'Count', kind: 'number' },
        { key: 'amount', label: 'Amount', kind: 'money' },
      ],
      rows: [
        ...(t.settlements?.payments ?? []).map((x: Json) => ({ method: label(x.tender), count: x.count, amount: x.amount })),
        { method: 'Charged to room', count: t.settlements?.roomCharges?.count ?? 0, amount: t.settlements?.roomCharges?.amount ?? '0.00' },
      ],
      totals: { method: 'Total settled', amount: t.settlements?.total },
      note: `Net sales less total settled: ${t.reconciliation?.difference ?? '0.00'} (should be 0.00).`,
    },
    {
      title: 'By category',
      columns: [
        { key: 'name', label: 'Category' },
        { key: 'quantity', label: 'Quantity', kind: 'number' },
        { key: 'amount', label: 'Net sales', kind: 'money' },
      ],
      rows: (t.byCategory ?? []).map((x: Json) => ({ name: x.name, quantity: x.quantity, amount: x.amount })),
    },
    {
      title: 'By waiter',
      columns: [
        { key: 'waiter', label: 'Waiter' },
        { key: 'checks', label: 'Checks', kind: 'number' },
        { key: 'amount', label: 'Net sales', kind: 'money' },
      ],
      rows: (t.byWaiter ?? []).map((x: Json) => ({ waiter: x.waiter, checks: x.checks, amount: x.amount })),
    },
    {
      title: 'Corrections',
      columns: [
        { key: 'kind', label: 'Kind' },
        { key: 'lines', label: 'Lines', kind: 'number' },
        { key: 'value', label: 'List value', kind: 'money' },
      ],
      rows: [
        { kind: 'Cancelled before preparation', lines: t.corrections?.cancelled?.lines ?? 0, value: t.corrections?.cancelled?.listValue ?? '0.00' },
        { kind: 'Waste after preparation', lines: t.corrections?.wasted?.lines ?? 0, value: t.corrections?.wasted?.listValue ?? '0.00' },
      ],
    },
    {
      title: 'House accounts (not revenue)',
      columns: [
        { key: 'name', label: 'Account' },
        { key: 'kind', label: 'Kind' },
        { key: 'costCentre', label: 'Cost centre' },
        { key: 'checks', label: 'Checks', kind: 'number' },
        { key: 'amount', label: 'Amount', kind: 'money' },
      ],
      rows: (t.houseAccounts?.accounts ?? []).map((x: Json) => ({ ...x, kind: label(x.kind) })),
    },
  ];
}

export function posSalesReport(data: Json, meta: Meta, outletName: string | null): Report {
  return {
    key: 'pos-sales',
    title: 'POS sales',
    ...meta,
    period: period(data.from, data.to),
    filters: [`Outlet: ${outletName ?? 'All outlets'}`],
    landscape: false,
    sections: [
      ...posTotalsSections(data),
      ...(outletName
        ? []
        : [{
            title: 'By outlet',
            columns: [
              { key: 'name', label: 'Outlet' },
              { key: 'checks', label: 'Checks', kind: 'number' as const },
              { key: 'netSales', label: 'Net sales', kind: 'money' as const },
            ],
            rows: data.byOutlet ?? [],
          }]),
      {
        title: 'By product',
        columns: [
          { key: 'name', label: 'Product' },
          { key: 'category', label: 'Category' },
          { key: 'quantity', label: 'Quantity', kind: 'number' },
          { key: 'discounts', label: 'Discounts', kind: 'money' },
          { key: 'amount', label: 'Net sales', kind: 'money' },
        ],
        rows: data.byItem ?? [],
      },
      {
        title: 'Voided checks',
        columns: [
          { key: 'number', label: 'Check' },
          { key: 'businessDate', label: 'Date', kind: 'date' },
          { key: 'outlet', label: 'Outlet' },
          { key: 'waiter', label: 'Waiter' },
          { key: 'reason', label: 'Reason' },
          { key: 'listValue', label: 'List value', kind: 'money' },
        ],
        rows: data.voids ?? [],
      },
      {
        title: 'Refunds',
        columns: [
          { key: 'number', label: 'Refund' },
          { key: 'businessDate', label: 'Date', kind: 'date' },
          { key: 'checkNumber', label: 'Check' },
          { key: 'outlet', label: 'Outlet' },
          { key: 'tender', label: 'Method' },
          { key: 'reason', label: 'Reason' },
          { key: 'refundedBy', label: 'By' },
          { key: 'amount', label: 'Amount', kind: 'money' },
        ],
        rows: (data.refundList ?? []).map((r: Json) => ({ ...r, tender: label(r.tender) })),
      },
    ],
    notes: [
      'Revenue is counted once, from closed checks, by trading date. A room charge is a way of settling a bill, not a second sale; house accounts are not sales.',
      'Amounts in KES.',
    ],
  };
}

export function posDayReport(day: Json, meta: Meta): Report {
  const closed = day.status === 'closed';
  const t = (day.totals ?? {}) as Json;
  return {
    key: `${closed ? 'z' : 'x'}-report-${day.outletCode}`,
    title: `${closed ? 'Z report' : 'X report (day still open)'}: ${day.outletName}`,
    ...meta,
    period: String(day.businessDate),
    filters: [
      `Opened ${day.openedAt ?? ''}`,
      ...(closed ? [`Closed ${day.closedAt ?? ''}${day.closedBy ? ` by ${day.closedBy}` : ''}`] : []),
    ],
    sections: t.empty ? [keyValueSection('Summary', [['Trading', 'No trading']])] : posTotalsSections(t),
    notes: ['Amounts in KES.'],
  };
}

export function cashShiftsReport(rows: Json[], from: string, to: string, meta: Meta, outletName: string | null): Report {
  const closed = rows.filter((r) => r.status === 'closed');
  const add = (k: string) => closed.reduce((a, r) => a + Math.round(Number(r[k] ?? 0) * 100), 0);
  const fmt = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
  return {
    key: 'cash-shifts',
    title: 'Cash shifts',
    ...meta,
    period: period(from, to),
    filters: [`Outlet: ${outletName ?? 'All outlets'}`],
    landscape: true,
    sections: [
      {
        title: 'Shifts',
        columns: [
          { key: 'number', label: 'Shift' },
          { key: 'businessDate', label: 'Date', kind: 'date' },
          { key: 'outlet', label: 'Outlet' },
          { key: 'cashier', label: 'Cashier' },
          { key: 'status', label: 'Status' },
          { key: 'openedAt', label: 'Opened' },
          { key: 'closedAt', label: 'Closed' },
          { key: 'openingFloat', label: 'Float', kind: 'money' },
          { key: 'expectedAmount', label: 'Expected', kind: 'money' },
          { key: 'countedAmount', label: 'Counted', kind: 'money' },
          { key: 'variance', label: 'Variance', kind: 'money' },
          { key: 'reviewedBy', label: 'Reviewed by' },
          { key: 'reviewNote', label: 'Review note' },
        ],
        rows: rows.map((r) => ({ ...r, status: label(r.status) })),
        totals: { number: `Closed shifts: ${closed.length}`, expectedAmount: fmt(add('expectedAmount')), countedAmount: fmt(add('countedAmount')), variance: fmt(add('variance')) },
      },
    ],
    notes: ['Variance = counted cash less expected cash; a non-zero variance needs a manager review (POS-13). Amounts in KES.'],
  };
}

const hotelDayColumns = [
  { key: 'date', label: 'Date', kind: 'date' as const },
  { key: 'availableRooms', label: 'Available', kind: 'number' as const },
  { key: 'occupiedRooms', label: 'Occupied', kind: 'number' as const },
  { key: 'compRooms', label: 'Comp', kind: 'number' as const },
  { key: 'roomsSold', label: 'Sold', kind: 'number' as const },
  { key: 'occupancy', label: 'Occupancy', kind: 'percent' as const },
  { key: 'roomRevenue', label: 'Room revenue (net)', kind: 'money' as const },
  { key: 'adr', label: 'ADR', kind: 'money' as const },
  { key: 'revpar', label: 'RevPAR', kind: 'money' as const },
  { key: 'arrivals', label: 'Arrivals', kind: 'number' as const },
  { key: 'departures', label: 'Departures', kind: 'number' as const },
  { key: 'cancellations', label: 'Cancelled', kind: 'number' as const },
  { key: 'noShows', label: 'No-shows', kind: 'number' as const },
  { key: 'status', label: 'Day' },
];

export function hotelReport(data: Json, meta: Meta): Report {
  const lostColumns = [
    { key: 'stayNumber', label: 'Stay' },
    { key: 'bookingNumber', label: 'Booking' },
    { key: 'guest', label: 'Guest' },
    { key: 'source', label: 'Source' },
    { key: 'roomType', label: 'Room type' },
    { key: 'arrival', label: 'Arrival', kind: 'date' as const },
    { key: 'nights', label: 'Nights', kind: 'number' as const },
    { key: 'bookedValue', label: 'Booked value', kind: 'money' as const },
    { key: 'feeCharged', label: 'Fee charged', kind: 'money' as const },
    { key: 'reason', label: 'Reason' },
    { key: 'at', label: 'When' },
  ];
  const segmentColumns = (first: { key: string; label: string }) => [
    first,
    { key: 'occupiedRooms', label: 'Occupied', kind: 'number' as const },
    { key: 'compRooms', label: 'Comp', kind: 'number' as const },
    { key: 'roomsSold', label: 'Sold', kind: 'number' as const },
    { key: 'roomRevenue', label: 'Room revenue (net)', kind: 'money' as const },
    { key: 'adr', label: 'ADR', kind: 'money' as const },
  ];
  return {
    key: 'hotel',
    title: 'Hotel report: room sales, occupancy, ADR and RevPAR',
    ...meta,
    period: period(data.from, data.to),
    landscape: true,
    sections: [
      {
        title: 'Daily room sales',
        columns: hotelDayColumns,
        rows: data.days.map((d: Json) => ({ ...d, status: d.closed ? 'Closed' : 'Open' })),
        totals: { date: `Closed days (${data.totals.closedDays})`, ...data.totals },
      },
      { title: 'By room type', columns: segmentColumns({ key: 'name', label: 'Room type' }), rows: data.byRoomType },
      { title: 'By booking source', columns: segmentColumns({ key: 'source', label: 'Source' }), rows: data.bySource.map((r: Json) => ({ ...r, source: label(r.source) })) },
      { title: 'Cancellations', columns: lostColumns.map((c) => (c.key === 'at' ? { ...c, label: 'Cancelled' } : c)), rows: data.cancellations.map((r: Json) => ({ ...r, source: label(r.source) })) },
      { title: 'No-shows', columns: lostColumns.map((c) => (c.key === 'at' ? { ...c, label: 'Marked' } : c)), rows: data.noShows.map((r: Json) => ({ ...r, source: label(r.source) })) },
    ],
    notes: [...HOTEL_DEFINITIONS, 'Amounts in KES.'],
  };
}

/** Flash report rows: one metric per row, one column per property (plus group total). */
function flashRows(ps: FlashProperty[], group: Json | null) {
  type Row = [string, (p: FlashProperty) => string | number, string | ((g: Json) => string | number) | null, 'money' | 'number' | 'percent' | 'text'];
  const rows: Row[] = [
    ['Day status', (p) => (p.dayClosed ? 'Closed' : 'Open (provisional)'), (g) => (g.dayClosed ? 'Closed' : 'Provisional'), 'text'],
    ['Available rooms', (p) => p.rooms.availableRooms, 'availableRooms', 'number'],
    ['Occupied rooms', (p) => p.rooms.occupiedRooms, 'occupiedRooms', 'number'],
    ['Rooms sold', (p) => p.rooms.roomsSold, 'roomsSold', 'number'],
    ['Occupancy', (p) => p.rooms.occupancy, 'occupancy', 'percent'],
    ['ADR', (p) => p.rooms.adr, 'adr', 'money'],
    ['RevPAR', (p) => p.rooms.revpar, 'revpar', 'money'],
    ['Arrivals', (p) => p.rooms.arrivals, null, 'number'],
    ['Departures', (p) => p.rooms.departures, null, 'number'],
    ['Cancellations', (p) => p.rooms.cancellations, null, 'number'],
    ['No-shows', (p) => p.rooms.noShows, null, 'number'],
    ['Room revenue (net)', (p) => p.revenue.rooms, 'roomRevenue', 'money'],
    ['F&B sales (POS, incl. tax)', (p) => p.revenue.posNetSales, 'posNetSales', 'money'],
    ['Other folio revenue (net)', (p) => p.revenue.otherFolio, 'otherFolio', 'money'],
    ['Total revenue (net of tax)', (p) => p.revenue.total, 'totalRevenue', 'money'],
    ['Money received', (p) => p.cash.total, 'cash', 'money'],
    ['Cash shifts', (p) => p.cashiers.shifts, null, 'number'],
    ['Cashier variance', (p) => p.cashiers.variance, 'cashierVariance', 'money'],
    ['Variances not reviewed', (p) => p.cashiers.unreviewed, null, 'number'],
    ['Open checks', (p) => p.exceptions.openChecks, null, 'number'],
    ['Outlet days not closed', (p) => p.exceptions.outletDaysOpen, null, 'number'],
    ['Voided checks', (p) => p.exceptions.voidedChecks, null, 'number'],
    ['POS refunds', (p) => p.exceptions.refunds, null, 'money'],
    ['House accounts', (p) => p.exceptions.houseAccounts, null, 'money'],
    ['POS sales not settled', (p) => p.exceptions.posDifference, null, 'money'],
    ['Arrivals not checked in (now)', (p) => p.exceptions.arrivalsNotCheckedIn, null, 'number'],
    ['Overdue departures (now)', (p) => p.exceptions.overdueDepartures, null, 'number'],
    ['In-house balances (now)', (p) => p.exceptions.inHouseBalance, null, 'money'],
    ['SAP postings failed', (p) => p.exceptions.sapFailed, null, 'number'],
  ];
  const sumOf = (f: (p: FlashProperty) => string | number, kind: string) => {
    if (kind === 'number') return ps.reduce((a, p) => a + Number(f(p)), 0);
    const cents = ps.reduce((a, p) => a + Math.round(Number(f(p)) * 100), 0);
    return `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
  };
  return rows.map(([name, f, g, kind]) => {
    const row: Record<string, string | number> = { item: name, _kind: kind };
    for (const p of ps) row[p.code] = f(p);
    if (group) {
      row.group = typeof g === 'function' ? g(group) : typeof g === 'string' ? group[g] : kind === 'text' ? '' : sumOf(f, kind);
    }
    return row;
  });
}

export function flashReport(ps: FlashProperty[], group: Json | null, date: string, meta: Meta): Report {
  const sections: Section[] = [
    {
      title: 'Flash',
      columns: [
        { key: 'item', label: 'Measure' },
        ...ps.map((p) => ({ key: p.code, label: p.name, kind: 'auto' as const })),
        ...(group ? [{ key: 'group', label: 'Group', kind: 'auto' as const }] : []),
      ],
      rows: flashRows(ps, group),
    },
  ];
  const cash: Section[] = ps.map((p) => ({
    title: `Money received by method: ${p.name}`,
    columns: [
      { key: 'tender', label: 'Method' },
      { key: 'frontDesk', label: 'Front desk', kind: 'money' },
      { key: 'pos', label: 'POS', kind: 'money' },
      { key: 'refunds', label: 'POS refunds', kind: 'money' },
      { key: 'total', label: 'Total', kind: 'money' },
    ],
    rows: p.cash.byTender.map((t) => ({ ...t, tender: label(t.tender) })),
    totals: { tender: 'Total', total: p.cash.total },
  }));
  return {
    key: 'flash',
    title: 'Daily flash report',
    ...meta,
    period: date,
    landscape: ps.length > 2,
    sections: [...sections, ...cash],
    notes: [
      ...HOTEL_DEFINITIONS.slice(0, 3),
      'F&B sales are closed POS checks by trading date, including tax. Total revenue adds room revenue, POS sales net of tax and other folio charges net of tax.',
      'Money received is confirmed folio payments and POS payments of the day, less POS refunds; charges to a room are not money received.',
      'Figures for a business day that is not yet closed are provisional. Amounts in KES.',
    ],
  };
}
