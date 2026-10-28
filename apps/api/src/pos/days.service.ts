import { Injectable, NotFoundException } from '@nestjs/common';
import { addDays, outletTradingDate, tradingDate } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { businessDate, conflict } from '../frontoffice/common';
import { actorId, localNow, outletByCode, PosOutlet } from './common';
import { PosReportsService } from './reports.service';

export interface OutletDay {
  id: string;
  outletId: string;
  businessDate: string;
  status: 'open' | 'closed';
}

/**
 * Outlet trading days (POS day close). The first check or shift of a day opens
 * it, dated by the outlet's cut-off; a manager closes it by hand once every
 * check and shift is closed, which freezes the day's totals. The property's
 * day close then refuses to run while an outlet day of that date is still open.
 */
@Injectable()
export class PosDaysService {
  constructor(
    private readonly db: DbService,
    private readonly reports: PosReportsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The outlet's open trading day, opening one if `open` is set. Takes the
   * property row FOR SHARE first, the same lock order as front-desk postings,
   * so the property's day close cannot slip in between.
   */
  async currentDay(q: Queryable, outlet: PosOutlet, open: boolean): Promise<OutletDay | null> {
    const propertyDate = await businessDate(q, outlet.propertyId, true);
    const existing = await this.openDay(q, outlet.id);
    if (existing || !open) return existing;

    const local = await localNow(q, outlet.propertyId);
    const date = outletTradingDate(local, outlet.cutoff, propertyDate);
    const { rows: closed } = await q.query<{ id: string }>(
      `SELECT id FROM pos_outlet_days WHERE outlet_id = $1 AND business_date = $2`,
      [outlet.id, date],
    );
    if (closed[0]) {
      const next = addDays(date, 1);
      throw conflict(
        next > addDays(propertyDate, 1)
          ? `${outlet.name} has closed ${date}. Close the property's business day ${propertyDate} before trading on ${next}.`
          : `${outlet.name} has closed ${date}. The next trading day (${next}) starts at ${outlet.cutoff}.`,
        'outlet_day_closed',
        { businessDate: date },
      );
    }
    await q.query(
      `INSERT INTO pos_outlet_days (property_id, outlet_id, business_date, opened_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [outlet.propertyId, outlet.id, date, actorId()],
    );
    const day = await this.openDay(q, outlet.id);
    if (!day) throw conflict(`${outlet.name}'s trading day ${date} could not be opened; try again`, 'outlet_day_closed');
    await this.audit.record({ action: 'pos.day_open', entityType: 'outlet', entityId: outlet.id, propertyId: outlet.propertyId, businessDate: day.businessDate });
    return day;
  }

  private async openDay(q: Queryable, outletId: string): Promise<OutletDay | null> {
    const { rows } = await q.query<OutletDay>(
      `SELECT id, outlet_id AS "outletId", business_date AS "businessDate", status FROM pos_outlet_days
        WHERE outlet_id = $1 AND status = 'open' FOR SHARE`,
      [outletId],
    );
    return rows[0] ?? null;
  }

  /** POS outlets with their trading-day status, for the floor and the back office. */
  async outlets(propertyId: string) {
    return this.db.tx(async (q) => {
      const local = await localNow(q, propertyId);
      const { rows } = await q.query<{
        id: string; code: string; name: string; type: string; cutoff: string; ownCutoff: string | null; serviceTypes: string[];
        sellsAlcohol: boolean; dayId: string | null; dayDate: string | null; openChecks: number; openShifts: number; lastClosed: string | null;
      }>(
        `SELECT o.id, o.code, o.name, o.type::text AS type, to_char(coalesce(o.business_day_cutoff, p.business_day_cutoff), 'HH24:MI') AS cutoff,
                to_char(o.business_day_cutoff, 'HH24:MI') AS "ownCutoff", o.service_types AS "serviceTypes", o.sells_alcohol AS "sellsAlcohol",
                d.id AS "dayId", d.business_date AS "dayDate",
                (SELECT count(*)::int FROM pos_checks c WHERE c.outlet_id = o.id AND c.status = 'open') AS "openChecks",
                (SELECT count(*)::int FROM cashier_shifts s WHERE s.outlet_id = o.id AND s.status = 'open') AS "openShifts",
                (SELECT max(business_date) FROM pos_outlet_days x WHERE x.outlet_id = o.id AND x.status = 'closed') AS "lastClosed"
           FROM outlets o JOIN properties p ON p.id = o.property_id
           LEFT JOIN pos_outlet_days d ON d.outlet_id = o.id AND d.status = 'open'
          WHERE o.property_id = $1 AND o.pos_enabled AND o.is_active
          ORDER BY o.code`,
        [propertyId],
      );
      return rows.map((o) => ({
        ...o,
        // The clock has passed the cut-off for the open day: it is due to be closed (closing stays manual).
        closeDue: o.dayDate !== null && tradingDate(local, o.cutoff) > o.dayDate,
        localTime: local,
      }));
    });
  }

  async days(propertyId: string, outletCode: string, limit = 30) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      const { rows } = await q.query(
        `SELECT d.id, d.business_date AS "businessDate", d.status, d.opened_at AS "openedAt", d.closed_at AS "closedAt",
                cu.display_name AS "closedBy", d.totals
           FROM pos_outlet_days d LEFT JOIN users cu ON cu.id = d.closed_by
          WHERE d.outlet_id = $1 ORDER BY d.business_date DESC LIMIT $2`,
        [outlet.id, limit],
      );
      return rows;
    });
  }

  async day(propertyId: string, dayId: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; status: string; totals: unknown; outletId: string }>(
        `SELECT d.id, d.business_date AS "businessDate", d.status, d.outlet_id AS "outletId", o.code AS "outletCode", o.name AS "outletName",
                d.opened_at AS "openedAt", d.closed_at AS "closedAt", cu.display_name AS "closedBy", d.totals
           FROM pos_outlet_days d JOIN outlets o ON o.id = d.outlet_id LEFT JOIN users cu ON cu.id = d.closed_by
          WHERE d.property_id = $1 AND d.id = $2`,
        [propertyId, dayId],
      );
      const day = rows[0];
      if (!day) throw new NotFoundException('Trading day not found at this property');
      // An open day shows its running totals; a closed one its frozen Z totals.
      return day.status === 'open' ? { ...day, totals: await this.reports.dayTotals(q, day.id) } : day;
    });
  }

  /**
   * POS day close (Z report). Manual, by a manager; refuses while any check or
   * cashier shift of the day is open. The totals are frozen with the day.
   */
  async closeDay(propertyId: string, outletCode: string, expectedDate: string) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      const { rows } = await q.query<{ id: string; status: string }>(
        `SELECT id, status FROM pos_outlet_days WHERE outlet_id = $1 AND business_date = $2 FOR UPDATE`,
        [outlet.id, expectedDate],
      );
      const day = rows[0];
      if (!day) throw conflict(`${outlet.name} has no trading day ${expectedDate}`, 'stale_business_date');
      if (day.status !== 'open') throw conflict(`${outlet.name} already closed ${expectedDate}`, 'stale_business_date');

      const { rows: open } = await q.query<{ number: string }>(
        `SELECT number FROM pos_checks WHERE outlet_day_id = $1 AND status = 'open' ORDER BY number`,
        [day.id],
      );
      if (open.length) {
        throw conflict(`${open.length} check(s) are still open: ${open.map((c) => c.number).join(', ')}. Settle, transfer or void them first.`, 'open_checks', {
          checks: open.map((c) => c.number),
        });
      }
      const { rows: shifts } = await q.query<{ number: string; name: string }>(
        `SELECT s.number, u.display_name AS name FROM cashier_shifts s JOIN users u ON u.id = s.user_id
          WHERE s.outlet_day_id = $1 AND s.status = 'open' ORDER BY s.number`,
        [day.id],
      );
      if (shifts.length) {
        throw conflict(`Cashier shift(s) still open: ${shifts.map((s) => `${s.number} (${s.name})`).join(', ')}. Count and close them first.`, 'open_shifts');
      }
      const totals = await this.reports.dayTotals(q, day.id);
      await q.query(
        `UPDATE pos_outlet_days SET status = 'closed', closed_at = now(), closed_by = $2, totals = $3, finalised_at = now() WHERE id = $1`,
        [day.id, actorId(), JSON.stringify(totals)],
      );
      await this.audit.record({
        action: 'pos.day_close', entityType: 'outlet', entityId: outlet.id, propertyId, businessDate: expectedDate,
        newValues: { netSales: totals.netSales, checks: totals.checks.closed },
      });
      return { outletCode: outlet.code, businessDate: expectedDate, dayId: day.id, totals };
    });
  }
}
