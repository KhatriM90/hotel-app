import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { outletByCode } from './common';

export interface PropertySettingsInput {
  businessDayCutoff?: string;
  posDiscountFreePercent?: string;
}

export interface OutletPosSettingsInput {
  posEnabled?: boolean;
  /** HH:MM, or null to follow the property's cut-off. */
  businessDayCutoff?: string | null;
  serviceTypes?: string[];
  liquorPolicy?: 'block' | 'warn';
  stockPolicy?: 'block' | 'warn';
  /** Replaces the outlet's licensed hours; a weekday left out sells no alcohol. */
  liquorHours?: { weekday: number; opensAt: string; closesAt: string }[];
  /** Station codes for kitchen and bar tickets; null removes the route. */
  routes?: { kitchen?: string | null; bar?: string | null };
}

/**
 * Business-day and POS settings (CFG-01, CFG-03). The cut-off decides which
 * trading day a sale belongs to; the property default is 08:00 and an outlet
 * may override it. A change applies to the next trading day: a day that is
 * already open keeps its date and is still closed by hand.
 */
@Injectable()
export class PosSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async get(propertyId: string) {
    return this.db.tx(async (q) => {
      const { rows: [property] } = await q.query(
        `SELECT code, name, timezone, to_char(business_day_cutoff, 'HH24:MI') AS "businessDayCutoff",
                pos_discount_free_percent::text AS "posDiscountFreePercent", current_business_date AS "currentBusinessDate"
           FROM properties WHERE id = $1`,
        [propertyId],
      );
      const { rows: outlets } = await q.query<{ id: string }>(
        `SELECT o.id, o.code, o.name, o.type::text AS type, o.is_active AS "isActive", o.pos_enabled AS "posEnabled",
                o.sells_alcohol AS "sellsAlcohol", to_char(o.business_day_cutoff, 'HH24:MI') AS "businessDayCutoff",
                o.service_types AS "serviceTypes", o.liquor_policy AS "liquorPolicy", o.stock_policy AS "stockPolicy",
                coalesce((SELECT jsonb_agg(jsonb_build_object('weekday', h.weekday, 'opensAt', to_char(h.opens_at, 'HH24:MI'),
                                                              'closesAt', to_char(h.closes_at, 'HH24:MI')) ORDER BY h.weekday)
                            FROM outlet_liquor_hours h WHERE h.outlet_id = o.id), '[]') AS "liquorHours",
                (SELECT jsonb_object_agg(r.route, s.code) FROM outlet_station_routes r JOIN pos_stations s ON s.id = r.station_id
                  WHERE r.outlet_id = o.id) AS routes
           FROM outlets o WHERE o.property_id = $1 ORDER BY o.code`,
        [propertyId],
      );
      const { rows: stations } = await q.query(
        `SELECT code, name, kind, printer_name AS "printerName", is_active AS "isActive" FROM pos_stations WHERE property_id = $1 ORDER BY code`,
        [propertyId],
      );
      return { property, outlets: outlets.map((o) => ({ ...o, routes: (o as { routes?: unknown }).routes ?? {} })), stations };
    });
  }

  async updateProperty(propertyId: string, input: PropertySettingsInput) {
    return this.db.tx(async (q) => {
      const { rows: [old] } = await q.query<{ cutoff: string; free: string }>(
        `SELECT to_char(business_day_cutoff, 'HH24:MI') AS cutoff, pos_discount_free_percent::text AS free FROM properties WHERE id = $1 FOR UPDATE`,
        [propertyId],
      );
      if (!old) throw new NotFoundException('Property not found');
      await q.query(
        `UPDATE properties SET business_day_cutoff = coalesce($2::time, business_day_cutoff),
                pos_discount_free_percent = coalesce($3::numeric, pos_discount_free_percent)
          WHERE id = $1`,
        [propertyId, input.businessDayCutoff ?? null, input.posDiscountFreePercent ?? null],
      );
      await this.audit.record({
        action: 'property.settings', entityType: 'property', entityId: propertyId, propertyId,
        previousValues: { businessDayCutoff: old.cutoff, posDiscountFreePercent: old.free },
        newValues: { ...input },
      });
      return this.get(propertyId);
    });
  }

  async updateOutlet(propertyId: string, outletCode: string, input: OutletPosSettingsInput) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      await q.query('SELECT 1 FROM outlets WHERE id = $1 FOR UPDATE', [outlet.id]);
      const sets: string[] = [];
      const params: unknown[] = [outlet.id];
      const set = (col: string, value: unknown, cast = '') => {
        params.push(value);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (input.posEnabled !== undefined) set('pos_enabled', input.posEnabled);
      if (input.businessDayCutoff !== undefined) set('business_day_cutoff', input.businessDayCutoff, '::time');
      if (input.serviceTypes !== undefined) set('service_types', [...new Set(input.serviceTypes)], '::text[]');
      if (input.liquorPolicy !== undefined) set('liquor_policy', input.liquorPolicy);
      if (input.stockPolicy !== undefined) set('stock_policy', input.stockPolicy);
      if (sets.length) await q.query(`UPDATE outlets SET ${sets.join(', ')} WHERE id = $1`, params);

      if (input.liquorHours) {
        const days = input.liquorHours.map((h) => h.weekday);
        if (new Set(days).size !== days.length) throw new UnprocessableEntityException('Give each weekday at most once');
        await q.query('DELETE FROM outlet_liquor_hours WHERE outlet_id = $1', [outlet.id]);
        for (const h of input.liquorHours) {
          await q.query(
            `INSERT INTO outlet_liquor_hours (outlet_id, property_id, weekday, opens_at, closes_at) VALUES ($1, $2, $3, $4, $5)`,
            [outlet.id, propertyId, h.weekday, h.opensAt, h.closesAt],
          );
        }
      }
      if (input.routes) {
        for (const route of ['kitchen', 'bar'] as const) {
          const code = input.routes[route];
          if (code === undefined) continue;
          await q.query('DELETE FROM outlet_station_routes WHERE outlet_id = $1 AND route = $2', [outlet.id, route]);
          if (code === null) continue;
          const stationId = await this.station(q, propertyId, code);
          await q.query(
            `INSERT INTO outlet_station_routes (outlet_id, property_id, route, station_id) VALUES ($1, $2, $3, $4)`,
            [outlet.id, propertyId, route, stationId],
          );
        }
      }
      await this.audit.record({
        action: 'outlet.pos_settings', entityType: 'outlet', entityId: outlet.id, propertyId,
        previousValues: { posEnabled: outlet.posEnabled, businessDayCutoff: outlet.ownCutoff, serviceTypes: outlet.serviceTypes,
          liquorPolicy: outlet.liquorPolicy, stockPolicy: outlet.stockPolicy },
        newValues: { ...input },
      });
      const all = await this.get(propertyId);
      return all.outlets.find((o) => (o as { id: string }).id === outlet.id);
    });
  }

  private async station(q: Queryable, propertyId: string, code: string): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM pos_stations WHERE property_id = $1 AND code = $2 AND is_active`,
      [propertyId, code.toUpperCase()],
    );
    if (!rows[0]) throw new NotFoundException(`Station ${code} not found at this property`);
    return rows[0].id;
  }
}
