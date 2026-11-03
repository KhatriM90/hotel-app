import { Injectable } from '@nestjs/common';
import { Money } from '@hotel/shared';
import { DbService } from '../db/db.service';
import { PosReportsService } from '../pos/reports.service';
import { HotelReportsService, Metrics } from './hotel-reports.service';

export interface FlashProperty {
  propertyId: string;
  code: string;
  name: string;
  date: string;
  /** False while the business day is still open: the figures are provisional. */
  dayClosed: boolean;
  rooms: Metrics & { totalRooms: number; blockedRooms: number; arrivals: number; departures: number; cancellations: number; noShows: number };
  revenue: { rooms: string; posNetSales: string; posNetExTax: string; otherFolio: string; total: string };
  /** Money received that day, by tender, from folios and POS bills, less POS refunds. */
  cash: { byTender: Array<{ tender: string; frontDesk: string; pos: string; refunds: string; total: string }>; total: string };
  cashiers: { shifts: number; openShifts: number; variance: string; unreviewed: number };
  exceptions: {
    openChecks: number;
    outletDaysOpen: number;
    voidedChecks: number;
    refunds: string;
    houseAccounts: string;
    posDifference: string;
    arrivalsNotCheckedIn: number;
    overdueDepartures: number;
    inHouseBalance: string;
    sapFailed: number;
  };
}

const sum = (xs: string[]) => Money.sum(xs.map((x) => Money.of(x))).toString();

/**
 * Daily flash report (RPT-07): one business date per property, built after
 * the property's day close (night audit) from the same queries as the hotel
 * and POS reports, so the numbers agree. The consolidated view puts every
 * property the user can see side by side with a group total (RPT-08).
 */
@Injectable()
export class FlashReportService {
  constructor(
    private readonly db: DbService,
    private readonly hotel: HotelReportsService,
    private readonly pos: PosReportsService,
  ) {}

  async forProperty(propertyId: string, date: string): Promise<FlashProperty> {
    const sales = await this.pos.sales(propertyId, { from: date, to: date });
    return this.db.tx(async (q) => {
      const { rows: [p] } = await q.query<{ code: string; name: string }>('SELECT code, name FROM properties WHERE id = $1', [propertyId]);
      const [day] = await this.hotel.daily(q, propertyId, date, date);
      const { rows: [other] } = await q.query<{ net: string }>(
        `SELECT coalesce(sum(net_amount), 0)::numeric(18,2)::text AS net FROM folio_charges
          WHERE property_id = $1 AND service_date = $2 AND charge_code <> 'ROOM' AND pos_check_id IS NULL`,
        [propertyId, date],
      );
      const { rows: desk } = await q.query<{ tender: string; amount: string }>(
        `SELECT tender::text AS tender, sum(amount)::numeric(18,2)::text AS amount FROM folio_payments
          WHERE property_id = $1 AND business_date = $2 AND status = 'confirmed' GROUP BY tender ORDER BY tender`,
        [propertyId, date],
      );
      const { rows: [shifts] } = await q.query<{ shifts: number; open: number; variance: string; unreviewed: number }>(
        `SELECT count(*)::int AS shifts, count(*) FILTER (WHERE s.status = 'open')::int AS open,
                coalesce(sum(s.variance), 0)::numeric(18,2)::text AS variance,
                count(*) FILTER (WHERE s.status = 'closed' AND s.variance <> 0 AND s.reviewed_at IS NULL)::int AS unreviewed
           FROM cashier_shifts s JOIN pos_outlet_days d ON d.id = s.outlet_day_id
          WHERE s.property_id = $1 AND d.business_date = $2`,
        [propertyId, date],
      );
      const { rows: [ex] } = await q.query<{ outletDaysOpen: number; arrivals: number; overdue: number; balance: string; sap: number }>(
        `SELECT (SELECT count(*)::int FROM pos_outlet_days WHERE property_id = $1 AND business_date = $2 AND status = 'open') AS "outletDaysOpen",
                (SELECT count(*)::int FROM stays WHERE property_id = $1 AND status IN ('hold', 'confirmed') AND arrival_date <= $2) AS arrivals,
                (SELECT count(*)::int FROM stays WHERE property_id = $1 AND status = 'checked_in' AND departure_date <= $2) AS overdue,
                (SELECT coalesce(sum(b.balance), 0)::numeric(18,2)::text FROM folio_balances b JOIN folios f ON f.id = b.folio_id
                   JOIN stays s ON s.id = f.stay_id WHERE b.property_id = $1 AND s.status = 'checked_in') AS balance,
                (SELECT count(*)::int FROM integration_outbox WHERE property_id = $1 AND status IN ('failed', 'dead')) AS sap`,
        [propertyId, date],
      );

      const tenders = new Set<string>([...desk.map((d) => d.tender), ...sales.settlements.payments.map((x) => x.tender), ...sales.refunds.byTender.map((x) => x.tender)]);
      const byTender = [...tenders].sort().map((tender) => {
        const frontDesk = desk.find((d) => d.tender === tender)?.amount ?? '0.00';
        const pos = sales.settlements.payments.find((x) => x.tender === tender)?.amount ?? '0.00';
        const refunds = sales.refunds.byTender.find((x) => x.tender === tender)?.amount ?? '0.00';
        return { tender, frontDesk, pos, refunds, total: Money.of(frontDesk).add(pos).subtract(refunds).toString() };
      });
      const { date: _d, closed, ...rooms } = day;
      return {
        propertyId,
        code: p.code,
        name: p.name,
        date,
        dayClosed: closed,
        rooms,
        revenue: {
          rooms: day.roomRevenue,
          posNetSales: sales.netSales,
          posNetExTax: sales.netExTax,
          otherFolio: other.net,
          total: sum([day.roomRevenue, sales.netExTax, other.net]),
        },
        cash: { byTender, total: sum(byTender.map((t) => t.total)) },
        cashiers: { shifts: shifts.shifts, openShifts: shifts.open, variance: shifts.variance, unreviewed: shifts.unreviewed },
        exceptions: {
          openChecks: sales.checks.open,
          outletDaysOpen: ex.outletDaysOpen,
          voidedChecks: sales.checks.void,
          refunds: sales.refunds.total,
          houseAccounts: sales.houseAccounts.total,
          posDifference: sales.reconciliation.difference,
          arrivalsNotCheckedIn: ex.arrivals,
          overdueDepartures: ex.overdue,
          inHouseBalance: ex.balance,
          sapFailed: ex.sap,
        },
      };
    });
  }

  /** Every property the user can see (row-level security decides), side by side. */
  async consolidated(date: string) {
    const { rows } = await this.db.tx((q) => q.query<{ id: string }>('SELECT id FROM properties WHERE is_active ORDER BY is_head_office DESC, code'));
    const properties: FlashProperty[] = [];
    for (const r of rows) properties.push(await this.forProperty(r.id, date));
    return { date, properties, group: FlashReportService.group(properties) };
  }

  /** Group totals: amounts and counts add up; ratios are recomputed from the sums. */
  static group(ps: FlashProperty[]) {
    const n = (f: (p: FlashProperty) => number) => ps.reduce((a, p) => a + f(p), 0);
    const m = (f: (p: FlashProperty) => string) => sum(ps.map(f));
    const available = n((p) => p.rooms.availableRooms);
    const occupied = n((p) => p.rooms.occupiedRooms);
    const sold = n((p) => p.rooms.roomsSold);
    const roomRevenue = m((p) => p.rooms.roomRevenue);
    return {
      dayClosed: ps.every((p) => p.dayClosed),
      availableRooms: available,
      occupiedRooms: occupied,
      roomsSold: sold,
      occupancy: available > 0 ? Money.of(String(occupied)).multiply(100).divide(available).toString() : '0.00',
      adr: sold > 0 ? Money.of(roomRevenue).divide(sold).toString() : '0.00',
      revpar: available > 0 ? Money.of(roomRevenue).divide(available).toString() : '0.00',
      roomRevenue,
      posNetSales: m((p) => p.revenue.posNetSales),
      otherFolio: m((p) => p.revenue.otherFolio),
      totalRevenue: m((p) => p.revenue.total),
      cash: m((p) => p.cash.total),
      cashierVariance: m((p) => p.cashiers.variance),
    };
  }
}
