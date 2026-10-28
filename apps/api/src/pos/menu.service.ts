import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { liquorAllowed, LiquorWindow } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { conflict } from '../frontoffice/common';
import { actorId, localNow, outletByCode } from './common';

export interface MenuItemInput {
  code: string;
  name: string;
  description?: string | null;
  categoryCode: string;
  chargeCode: string;
  isAlcohol: boolean;
  sapItemCode?: string | null;
  portions: Array<{ code: string; name: string }>;
  modifierGroupCodes?: string[];
}

/**
 * Group menu defined once (CFG-05, POS-02) and each outlet's own price list,
 * availability and favourites (POS-01, POS-03, POS-12, POS-19).
 */
@Injectable()
export class PosMenuService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async liquorWindows(q: Queryable, outletId: string): Promise<LiquorWindow[]> {
    const { rows } = await q.query<LiquorWindow>(
      `SELECT weekday, to_char(opens_at, 'HH24:MI') AS "opensAt", to_char(closes_at, 'HH24:MI') AS "closesAt"
         FROM outlet_liquor_hours WHERE outlet_id = $1 ORDER BY weekday`,
      [outletId],
    );
    return rows;
  }

  /** Everything the POS screen needs for one outlet: categories, items, portions, prices, modifiers, tables. */
  async outletMenu(propertyId: string, outletCode: string) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode);
      const local = await localNow(q, propertyId);
      const hours = await this.liquorWindows(q, outlet.id);
      const { rows: items } = await q.query(
        `SELECT mp.id AS "priceId", mi.id AS "itemId", mi.code, mi.name, mi.description, mi.image_url AS "imageUrl",
                mc.code AS "categoryCode", mi.is_alcohol AS "isAlcohol", mp.portion_id AS "portionId", pt.code AS "portionCode",
                pt.name AS "portionName", mp.price, mp.is_available AS "isAvailable", mp.is_favourite AS "isFavourite",
                mp.stock_remaining::text AS "stockRemaining",
                coalesce((SELECT array_agg(g.code ORDER BY ig.sort_order) FROM menu_item_modifier_groups ig
                           JOIN modifier_groups g ON g.id = ig.group_id WHERE ig.item_id = mi.id), '{}') AS "modifierGroups"
           FROM outlet_menu_prices mp
           JOIN menu_items mi ON mi.id = mp.item_id AND mi.is_active
           JOIN menu_item_portions pt ON pt.id = mp.portion_id
           JOIN menu_categories mc ON mc.id = mi.category_id AND mc.is_active
          WHERE mp.outlet_id = $1
          ORDER BY mc.sort_order, mp.sort_order, mi.name, pt.sort_order`,
        [outlet.id],
      );
      const { rows: categories } = await q.query(
        `SELECT DISTINCT mc.code, mc.name, mc.route, mc.sort_order AS "sortOrder"
           FROM outlet_menu_prices mp JOIN menu_items mi ON mi.id = mp.item_id JOIN menu_categories mc ON mc.id = mi.category_id
          WHERE mp.outlet_id = $1 AND mc.is_active ORDER BY mc.sort_order, mc.code`,
        [outlet.id],
      );
      const { rows: modifierGroups } = await q.query(
        `SELECT g.code, g.name, g.min_select AS "minSelect", g.max_select AS "maxSelect",
                json_agg(json_build_object('id', o.id, 'code', o.code, 'name', o.name, 'priceDelta', o.price_delta::text) ORDER BY o.sort_order) AS options
           FROM modifier_groups g JOIN modifier_options o ON o.group_id = g.id AND o.is_active
          WHERE g.id IN (SELECT ig.group_id FROM menu_item_modifier_groups ig JOIN outlet_menu_prices mp ON mp.item_id = ig.item_id WHERE mp.outlet_id = $1)
          GROUP BY g.id ORDER BY g.code`,
        [outlet.id],
      );
      const { rows: tables } = await q.query(
        `SELECT id, code, area, seats FROM pos_tables WHERE outlet_id = $1 AND is_active ORDER BY area, sort_order, code`,
        [outlet.id],
      );
      return {
        outlet: { code: outlet.code, name: outlet.name, type: outlet.type, serviceTypes: outlet.serviceTypes, cutoff: outlet.cutoff, liquorPolicy: outlet.liquorPolicy, stockPolicy: outlet.stockPolicy },
        localTime: local,
        liquorHours: hours,
        liquorAllowedNow: liquorAllowed(hours, local),
        categories,
        items,
        modifierGroups,
        tables,
      };
    });
  }

  /** Price, favourite and stock count (menu managers). */
  async updatePrice(propertyId: string, outletCode: string, priceId: string, input: { price?: string; isFavourite?: boolean; stockRemaining?: string | null; sortOrder?: number }) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      const before = await this.priceRow(q, outlet.id, priceId);
      const { rows } = await q.query(
        `UPDATE outlet_menu_prices SET price = coalesce($3, price), is_favourite = coalesce($4, is_favourite),
                stock_remaining = CASE WHEN $5::boolean THEN $6::numeric ELSE stock_remaining END,
                sort_order = coalesce($7, sort_order), updated_by = $8
          WHERE outlet_id = $1 AND id = $2
          RETURNING id, price, is_favourite AS "isFavourite", stock_remaining::text AS "stockRemaining", is_available AS "isAvailable"`,
        [outlet.id, priceId, input.price ?? null, input.isFavourite ?? null, input.stockRemaining !== undefined, input.stockRemaining ?? null,
         input.sortOrder ?? null, actorId()],
      );
      await this.audit.record({ action: 'pos.menu_price', entityType: 'outlet_menu_price', entityId: priceId, propertyId, previousValues: before, newValues: rows[0] });
      return rows[0];
    });
  }

  /** Mark an item unavailable ("86") or back on (POS-12). The POS refuses unavailable items. */
  async setAvailability(propertyId: string, outletCode: string, priceId: string, isAvailable: boolean) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      await this.priceRow(q, outlet.id, priceId);
      const { rows } = await q.query(
        `UPDATE outlet_menu_prices SET is_available = $3, updated_by = $4 WHERE outlet_id = $1 AND id = $2
         RETURNING id, is_available AS "isAvailable"`,
        [outlet.id, priceId, isAvailable, actorId()],
      );
      await this.audit.record({ action: isAvailable ? 'pos.item_available' : 'pos.item_unavailable', entityType: 'outlet_menu_price', entityId: priceId, propertyId });
      return rows[0];
    });
  }

  async addToOutlet(propertyId: string, outletCode: string, input: { itemCode: string; portionCode?: string; price: string }) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      const { rows: portion } = await q.query<{ itemId: string; portionId: string }>(
        `SELECT mi.id AS "itemId", pt.id AS "portionId" FROM menu_items mi JOIN menu_item_portions pt ON pt.item_id = mi.id
          WHERE mi.code = $1 AND pt.code = $2`,
        [input.itemCode.toUpperCase(), (input.portionCode ?? 'STD').toUpperCase()],
      );
      if (!portion[0]) throw new NotFoundException(`Menu item ${input.itemCode} / ${input.portionCode ?? 'STD'} not found`);
      const { rows } = await q.query(
        `INSERT INTO outlet_menu_prices (property_id, outlet_id, item_id, portion_id, price, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (outlet_id, portion_id) DO UPDATE SET price = EXCLUDED.price, updated_by = EXCLUDED.updated_by
         RETURNING id, price`,
        [propertyId, outlet.id, portion[0].itemId, portion[0].portionId, input.price, actorId()],
      );
      await this.audit.record({ action: 'pos.menu_add', entityType: 'outlet_menu_price', entityId: rows[0].id, propertyId, newValues: input });
      return rows[0];
    });
  }

  private async priceRow(q: Queryable, outletId: string, priceId: string) {
    const { rows } = await q.query(
      `SELECT id, price, is_available AS "isAvailable", is_favourite AS "isFavourite", stock_remaining::text AS "stockRemaining"
         FROM outlet_menu_prices WHERE outlet_id = $1 AND id = $2`,
      [outletId, priceId],
    );
    if (!rows[0]) throw new NotFoundException('Price not found on this outlet’s menu');
    return rows[0];
  }

  /**
   * Outlet template (POS-19): copies the price list, service types, policies
   * and liquor hours from one outlet to another, including across properties
   * the user can see. Tables and printers are physical and are not copied.
   */
  async copyOutlet(fromCode: string, toCode: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; propertyId: string; code: string }>(
        `SELECT id, property_id AS "propertyId", code FROM outlets WHERE code = ANY($1)`,
        [[fromCode.toUpperCase(), toCode.toUpperCase()]],
      );
      const from = rows.find((r) => r.code === fromCode.toUpperCase());
      const to = rows.find((r) => r.code === toCode.toUpperCase());
      if (!from || !to) throw new NotFoundException('Both outlets must exist and be visible to you');
      if (from.id === to.id) throw new BadRequestException('Choose two different outlets');
      const { rowCount: prices } = await q.query(
        `INSERT INTO outlet_menu_prices (property_id, outlet_id, item_id, portion_id, price, is_available, is_favourite, sort_order, updated_by)
         SELECT $2, $3, item_id, portion_id, price, is_available, is_favourite, sort_order, $4 FROM outlet_menu_prices WHERE outlet_id = $1
         ON CONFLICT (outlet_id, portion_id) DO UPDATE SET price = EXCLUDED.price, is_available = EXCLUDED.is_available,
                is_favourite = EXCLUDED.is_favourite, sort_order = EXCLUDED.sort_order, updated_by = EXCLUDED.updated_by`,
        [from.id, to.propertyId, to.id, actorId()],
      );
      await q.query('DELETE FROM outlet_liquor_hours WHERE outlet_id = $1', [to.id]);
      const { rowCount: hours } = await q.query(
        `INSERT INTO outlet_liquor_hours (outlet_id, property_id, weekday, opens_at, closes_at)
         SELECT $2, $3, weekday, opens_at, closes_at FROM outlet_liquor_hours WHERE outlet_id = $1`,
        [from.id, to.id, to.propertyId],
      );
      await q.query(
        `UPDATE outlets t SET pos_enabled = f.pos_enabled, service_types = f.service_types, liquor_policy = f.liquor_policy,
                stock_policy = f.stock_policy, business_day_cutoff = f.business_day_cutoff
           FROM outlets f WHERE f.id = $1 AND t.id = $2`,
        [from.id, to.id],
      );
      await this.audit.record({ action: 'pos.outlet_copy', entityType: 'outlet', entityId: to.id, propertyId: to.propertyId, newValues: { from: from.code, prices, hours } });
      return { from: from.code, to: to.code, pricesCopied: prices ?? 0, liquorHoursCopied: hours ?? 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Group menu (CFG-05)
  // -------------------------------------------------------------------------

  async groupMenu() {
    const { rows: categories } = await this.db.query(
      `SELECT code, name, route, sort_order AS "sortOrder", is_active AS "isActive" FROM menu_categories ORDER BY sort_order, code`,
    );
    const { rows: items } = await this.db.query(
      `SELECT mi.id, mi.code, mi.name, mi.description, mc.code AS "categoryCode", mi.charge_code AS "chargeCode", mi.is_alcohol AS "isAlcohol",
              mi.sap_item_code AS "sapItemCode", mi.is_active AS "isActive",
              (SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.name) ORDER BY p.sort_order) FROM menu_item_portions p WHERE p.item_id = mi.id) AS portions,
              coalesce((SELECT array_agg(g.code ORDER BY ig.sort_order) FROM menu_item_modifier_groups ig JOIN modifier_groups g ON g.id = ig.group_id WHERE ig.item_id = mi.id), '{}') AS "modifierGroups"
         FROM menu_items mi JOIN menu_categories mc ON mc.id = mi.category_id ORDER BY mc.sort_order, mi.name`,
    );
    const { rows: modifierGroups } = await this.db.query(
      `SELECT g.code, g.name, g.min_select AS "minSelect", g.max_select AS "maxSelect",
              json_agg(json_build_object('code', o.code, 'name', o.name, 'priceDelta', o.price_delta::text) ORDER BY o.sort_order) AS options
         FROM modifier_groups g JOIN modifier_options o ON o.group_id = g.id GROUP BY g.id ORDER BY g.code`,
    );
    return { categories, items, modifierGroups };
  }

  async createItem(input: MenuItemInput) {
    return this.db.tx(async (q) => {
      const { rows: cat } = await q.query<{ id: string }>('SELECT id FROM menu_categories WHERE code = $1', [input.categoryCode.toUpperCase()]);
      if (!cat[0]) throw new BadRequestException(`Unknown category ${input.categoryCode}`);
      const { rows: cc } = await q.query("SELECT 1 FROM charge_codes WHERE code = $1 AND category IN ('food', 'beverage', 'minibar', 'other')", [input.chargeCode]);
      if (!cc[0]) throw new BadRequestException(`Charge code ${input.chargeCode} is not a POS tax category`);
      let item: { id: string };
      try {
        ({ rows: [item] } = await q.query<{ id: string }>(
          `INSERT INTO menu_items (code, name, description, category_id, charge_code, is_alcohol, sap_item_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [input.code.toUpperCase(), input.name, input.description ?? null, cat[0].id, input.chargeCode, input.isAlcohol, input.sapItemCode ?? null],
        ));
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict(`Menu item ${input.code} already exists`, 'duplicate');
        throw err;
      }
      for (const [i, p] of input.portions.entries()) {
        await q.query('INSERT INTO menu_item_portions (item_id, code, name, sort_order) VALUES ($1, $2, $3, $4)', [item.id, p.code.toUpperCase(), p.name, i]);
      }
      for (const [i, code] of (input.modifierGroupCodes ?? []).entries()) {
        const { rowCount } = await q.query(
          `INSERT INTO menu_item_modifier_groups (item_id, group_id, sort_order) SELECT $1, id, $3 FROM modifier_groups WHERE code = $2`,
          [item.id, code.toUpperCase(), i],
        );
        if (!rowCount) throw new BadRequestException(`Unknown modifier group ${code}`);
      }
      await this.audit.record({ action: 'pos.menu_item_create', entityType: 'menu_item', entityId: item.id, newValues: input });
      return { id: item.id, code: input.code.toUpperCase() };
    });
  }

  // -------------------------------------------------------------------------
  // Tables, stations and house accounts
  // -------------------------------------------------------------------------

  async stations(propertyId: string) {
    const { rows } = await this.db.query(
      `SELECT id, code, name, kind, printer_name AS "printerName", is_active AS "isActive" FROM pos_stations WHERE property_id = $1 ORDER BY code`,
      [propertyId],
    );
    return rows;
  }

  async houseAccounts(propertyId: string) {
    const { rows } = await this.db.query(
      `SELECT ha.id, ha.code, ha.name, ha.kind, ha.monthly_limit AS "monthlyLimit", ha.cost_centre AS "costCentre", ha.is_active AS "isActive",
              coalesce((SELECT sum(h.amount) FROM house_account_charges h
                         WHERE h.house_account_id = ha.id AND date_trunc('month', h.business_date) = date_trunc('month', p.current_business_date)), 0)::numeric(18,2)::text AS "usedThisMonth"
         FROM house_accounts ha JOIN properties p ON p.id = ha.property_id
        WHERE ha.property_id = $1 ORDER BY ha.code`,
      [propertyId],
    );
    return rows;
  }

  async createHouseAccount(propertyId: string, input: { code: string; name: string; kind: string; monthlyLimit?: string | null; costCentre?: string | null }) {
    return this.db.tx(async (q) => {
      try {
        const { rows } = await q.query(
          `INSERT INTO house_accounts (property_id, code, name, kind, monthly_limit, cost_centre) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, code, name, kind, monthly_limit AS "monthlyLimit", cost_centre AS "costCentre"`,
          [propertyId, input.code.toUpperCase(), input.name, input.kind, input.monthlyLimit ?? null, input.costCentre ?? null],
        );
        await this.audit.record({ action: 'pos.house_account_create', entityType: 'house_account', entityId: rows[0].id, propertyId, newValues: input });
        return rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict(`House account ${input.code} already exists`, 'duplicate');
        throw err;
      }
    });
  }
}
