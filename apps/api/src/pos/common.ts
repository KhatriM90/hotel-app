import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { splitInclusiveTax, TaxSplit } from '@hotel/shared';
import { Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { conflict } from '../frontoffice/common';

export interface PosOutlet {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  type: string;
  revenueCentre: string;
  posEnabled: boolean;
  isActive: boolean;
  /** The outlet's own cut-off, or the property's when it has none (HH:MM). */
  cutoff: string;
  ownCutoff: string | null;
  serviceTypes: string[];
  liquorPolicy: 'block' | 'warn';
  stockPolicy: 'block' | 'warn';
  sapDimension2Code: string | null;
  issuingWarehouseCode: string | null;
}

export const OUTLET_SQL = `
  SELECT o.id, o.property_id AS "propertyId", o.code, o.name, o.type::text AS type, o.revenue_centre::text AS "revenueCentre",
         o.pos_enabled AS "posEnabled", o.is_active AS "isActive",
         to_char(coalesce(o.business_day_cutoff, p.business_day_cutoff), 'HH24:MI') AS cutoff,
         to_char(o.business_day_cutoff, 'HH24:MI') AS "ownCutoff",
         o.service_types AS "serviceTypes", o.liquor_policy AS "liquorPolicy", o.stock_policy AS "stockPolicy",
         o.sap_dimension2_code AS "sapDimension2Code", o.issuing_warehouse_code AS "issuingWarehouseCode"
    FROM outlets o JOIN properties p ON p.id = o.property_id`;

export async function outletByCode(q: Queryable, propertyId: string, code: string, requirePos = true): Promise<PosOutlet> {
  const { rows } = await q.query<PosOutlet>(`${OUTLET_SQL} WHERE o.property_id = $1 AND o.code = $2`, [propertyId, code.toUpperCase()]);
  const outlet = rows[0];
  if (!outlet) throw new NotFoundException(`Outlet ${code} not found at this property`);
  if (requirePos && (!outlet.posEnabled || !outlet.isActive)) {
    throw conflict(`${outlet.name} does not sell on the POS`, 'outlet_not_pos');
  }
  return outlet;
}

export async function outletById(q: Queryable, id: string): Promise<PosOutlet> {
  const { rows } = await q.query<PosOutlet>(`${OUTLET_SQL} WHERE o.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundException('Outlet not found');
  return rows[0];
}

/** Wall-clock time at the property, "YYYY-MM-DDTHH:MM:SS" (CFG-01 time zone). */
export async function localNow(q: Queryable, propertyId: string): Promise<string> {
  const { rows } = await q.query<{ local: string }>(
    `SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD"T"HH24:MI:SS') AS local FROM properties WHERE id = $1`,
    [propertyId],
  );
  if (!rows[0]) throw new NotFoundException('Property not found');
  return rows[0].local;
}

export function actorId(): string | null {
  return requestContext.get()?.user?.id ?? null;
}

/**
 * Tax split of a tax-inclusive amount by the charge code's tax codes, with the
 * rates in force now (BIL-08, BIL-16: VAT and catering levy as separate lines).
 * Menu prices always include tax.
 */
export async function inclusiveTaxes(q: Queryable, chargeCode: string, amount: string): Promise<TaxSplit> {
  const { rows } = await q.query<{ code: string; ratePercent: string }>(
    `SELECT t.sap_code AS code, t.rate_percent::text AS "ratePercent"
       FROM charge_codes c CROSS JOIN LATERAL unnest(c.tax_codes) WITH ORDINALITY AS u(code, ord)
       JOIN tax_codes t ON t.sap_code = u.code AND t.is_active
      WHERE c.code = $1 ORDER BY u.ord`,
    [chargeCode],
  );
  const { rows: codes } = await q.query<{ n: number }>('SELECT cardinality(tax_codes) AS n FROM charge_codes WHERE code = $1', [chargeCode]);
  if (!codes[0]) throw new UnprocessableEntityException(`Unknown charge code ${chargeCode}`);
  if (codes[0].n !== rows.length) throw new UnprocessableEntityException(`Charge code ${chargeCode} refers to an inactive tax code`);
  return splitInclusiveTax(amount, rows);
}

export async function event(
  q: Queryable,
  propertyId: string,
  checkId: string,
  name: string,
  details: Record<string, unknown> | null = null,
  lineId: string | null = null,
): Promise<void> {
  await q.query(
    `INSERT INTO pos_check_events (property_id, check_id, line_id, event, details, actor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [propertyId, checkId, lineId, name, details ? JSON.stringify(details) : null, actorId()],
  );
}

/**
 * Called by the property's day close (front desk) under its property lock:
 * outlet trading days of that date or earlier with no checks and no shifts
 * close themselves; any with activity must be closed by a manager first.
 * A plain function, so the front desk needs no POS module dependency.
 */
export async function assertOutletDaysClosed(q: Queryable, propertyId: string, date: string): Promise<void> {
  await q.query(
    `UPDATE pos_outlet_days d SET status = 'closed', closed_at = now(), closed_by = $3, finalised_at = now(),
            totals = jsonb_build_object('empty', true)
      WHERE d.property_id = $1 AND d.status = 'open' AND d.business_date <= $2
        AND NOT EXISTS (SELECT 1 FROM pos_checks c WHERE c.outlet_day_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM cashier_shifts s WHERE s.outlet_day_id = d.id)`,
    [propertyId, date, actorId()],
  );
  const { rows } = await q.query<{ name: string; date: string }>(
    `SELECT o.name, d.business_date AS date FROM pos_outlet_days d JOIN outlets o ON o.id = d.outlet_id
      WHERE d.property_id = $1 AND d.status = 'open' AND d.business_date <= $2 ORDER BY o.name`,
    [propertyId, date],
  );
  if (rows.length) {
    throw conflict(
      `Close the POS day at ${rows.map((r) => `${r.name} (${r.date})`).join(', ')} before closing the property's business day`,
      'outlet_days_open',
      { outlets: rows.map((r) => r.name) },
    );
  }
}

/** Open POS checks linked to a stay block its checkout (BIL-11). */
export async function assertNoOpenChecksForStay(q: Queryable, stayId: string): Promise<void> {
  const { rows } = await q.query<{ number: string; outlet: string }>(
    `SELECT c.number, o.name AS outlet FROM pos_checks c JOIN outlets o ON o.id = c.outlet_id
      WHERE c.stay_id = $1 AND c.status = 'open' ORDER BY c.number`,
    [stayId],
  );
  if (rows.length) {
    throw conflict(
      `Open POS check(s) for this guest: ${rows.map((r) => `${r.number} at ${r.outlet}`).join(', ')}. Settle or charge them to the room first.`,
      'open_pos_checks',
      { checks: rows.map((r) => r.number) },
    );
  }
}
