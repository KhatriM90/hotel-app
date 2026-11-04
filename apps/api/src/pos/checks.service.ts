import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  hasPermission,
  liquorAllowed,
  Money,
  PREPARED_LINE_STATUSES,
  priceLine,
  ruleApplies,
  ServiceType,
} from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { LoyaltyCheckoutService } from '../loyalty/checkout.service';
import { ApprovalsService } from '../frontoffice/approvals.service';
import { ApprovalInputT, conflict, isPgError, withSavepoint } from '../frontoffice/common';
import { NumberingService } from '../numbering/numbering.service';
import { actorId, event, inclusiveTaxes, localNow, outletByCode, outletById, PosOutlet } from './common';
import { PosDaysService } from './days.service';
import { PosMenuService } from './menu.service';

export interface LockedCheck {
  id: string;
  propertyId: string;
  number: string;
  outletId: string;
  outletDayId: string;
  businessDate: string;
  serviceType: ServiceType;
  tableId: string | null;
  tabName: string | null;
  covers: number;
  waiterId: string;
  stayId: string | null;
  status: 'open' | 'closed' | 'void' | 'merged';
  loyaltyMemberId: string | null;
  loyaltyBenefit: 'discount' | 'cashback' | null;
}

interface LineRow {
  id: string;
  checkId: string;
  name: string;
  chargeCode: string;
  route: 'kitchen' | 'bar' | 'none';
  quantity: string;
  unitPrice: string;
  modifiersUnitPrice: string;
  modifiers: Array<{ name: string }>;
  rulePercent: string;
  discountPercent: string;
  isComp: boolean;
  amount: string;
  notes: string | null;
  status: string;
  sentAt: string | null;
  ticketId: string | null;
  itemId: string;
  portionId: string;
  isAlcohol: boolean;
}

export interface OpenCheckInput {
  id?: string;
  serviceType: ServiceType;
  tableId?: string | null;
  tabName?: string | null;
  covers?: number;
  stayId?: string | null;
  notes?: string | null;
  deviceId?: string | null;
  clientOpenedAt?: string | null;
}

export interface AddLinesInput {
  lines: Array<{ id?: string; portionId: string; quantity: string; modifierOptionIds?: string[]; notes?: string | null }>;
  acknowledgeWarnings?: boolean;
  liquorOverrideReason?: string;
  approval?: ApprovalInputT;
}

const CHECK_COLUMNS = `id, property_id AS "propertyId", number, outlet_id AS "outletId", outlet_day_id AS "outletDayId",
  business_date AS "businessDate", service_type::text AS "serviceType", table_id AS "tableId", tab_name AS "tabName", covers,
  waiter_id AS "waiterId", stay_id AS "stayId", status, loyalty_member_id AS "loyaltyMemberId", loyalty_benefit AS "loyaltyBenefit"`;

const LINE_COLUMNS = `id, check_id AS "checkId", name, charge_code AS "chargeCode", route, quantity::text AS quantity, unit_price AS "unitPrice",
  modifiers_unit_price AS "modifiersUnitPrice", modifiers, rule_percent::text AS "rulePercent", discount_percent::text AS "discountPercent",
  is_comp AS "isComp", amount, notes, status, sent_at AS "sentAt", ticket_id AS "ticketId", item_id AS "itemId", portion_id AS "portionId",
  is_alcohol AS "isAlcohol"`;

/**
 * Orders, kitchen/bar tickets and bill operations (POS-01 … POS-08, POS-11,
 * POS-12, POS-17). Every change locks the check row first and is recorded in
 * pos_check_events, so additions, moves and cancellations stay traceable.
 */
@Injectable()
export class PosChecksService {
  constructor(
    private readonly db: DbService,
    private readonly days: PosDaysService,
    private readonly menu: PosMenuService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly loyalty: LoyaltyCheckoutService,
  ) {}

  async lock(q: Queryable, propertyId: string, checkId: string, requireOpen = true): Promise<LockedCheck> {
    const { rows } = await q.query<LockedCheck>(`SELECT ${CHECK_COLUMNS} FROM pos_checks WHERE property_id = $1 AND id = $2 FOR UPDATE`, [
      propertyId,
      checkId,
    ]);
    const check = rows[0];
    if (!check) throw new NotFoundException('Check not found at this property');
    if (requireOpen && check.status !== 'open') throw conflict(`Check ${check.number} is ${check.status}`, 'check_closed');
    return check;
  }

  /** Lines of a check; `where` may use $2, $3 … for `params`. */
  async lines(q: Queryable, checkId: string, where = 'TRUE', params: unknown[] = []): Promise<LineRow[]> {
    const { rows } = await q.query<LineRow>(`SELECT ${LINE_COLUMNS} FROM pos_check_lines WHERE check_id = $1 AND ${where} ORDER BY added_at, id`, [
      checkId,
      ...params,
    ]);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(propertyId: string, outletCode: string, status = 'open') {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode, false);
      const { rows } = await q.query(
        `SELECT c.id, c.number, c.status, c.service_type AS "serviceType", t.code AS "tableCode", c.tab_name AS "tabName", c.covers,
                u.display_name AS waiter, c.waiter_id AS "waiterId", rm.number AS "roomNumber", c.business_date AS "businessDate",
                c.opened_at AS "openedAt", c.closed_at AS "closedAt", c.settlement, tot.total, tot.balance, tot.pending,
                (SELECT count(*)::int FROM pos_check_lines l WHERE l.check_id = c.id AND l.status = 'draft') AS "unsentLines",
                (SELECT count(*)::int FROM pos_check_lines l WHERE l.check_id = c.id AND l.status = 'ready') AS "readyLines"
           FROM pos_checks c JOIN pos_check_totals tot ON tot.check_id = c.id
           JOIN users u ON u.id = c.waiter_id
           LEFT JOIN pos_tables t ON t.id = c.table_id
           LEFT JOIN stays s ON s.id = c.stay_id LEFT JOIN rooms rm ON rm.id = s.room_id
          WHERE c.outlet_id = $1 AND ($2 = 'all' OR c.status = $2)
            AND ($2 = 'open' OR c.business_date >= (SELECT current_business_date - 1 FROM properties WHERE id = c.property_id))
          ORDER BY c.status = 'open' DESC, c.opened_at DESC
          LIMIT 200`,
        [outlet.id, status],
      );
      return rows;
    });
  }

  async get(propertyId: string, checkId: string) {
    return this.db.tx((q) => this.view(q, propertyId, checkId));
  }

  async view(q: Queryable, propertyId: string, checkId: string) {
    const { rows } = await q.query(
      `SELECT c.id, c.number, c.status, c.settlement, c.service_type AS "serviceType", c.business_date AS "businessDate",
              o.code AS "outletCode", o.name AS "outletName", c.table_id AS "tableId", t.code AS "tableCode", c.tab_name AS "tabName", c.covers,
              c.waiter_id AS "waiterId", u.display_name AS waiter, c.stay_id AS "stayId", s.number AS "stayNumber", rm.number AS "roomNumber",
              CASE WHEN g.id IS NULL THEN NULL ELSE g.first_name || ' ' || g.last_name END AS "guestName",
              c.notes, c.opened_at AS "openedAt", c.closed_at AS "closedAt", c.merged_into_id AS "mergedIntoId", c.void_reason AS "voidReason",
              c.device_id AS "deviceId",
              json_build_object('total', tot.total::text, 'tax', tot.tax::text, 'discounts', tot.discounts::text, 'paid', tot.paid::text,
                                'pending', tot.pending::text, 'roomCharged', tot.room_charged::text, 'houseCharged', tot.house_charged::text,
                                'refunded', tot.refunded::text, 'balance', tot.balance::text, 'memberDiscount', tot.member_discount::text,
                                'rewards', tot.rewards::text) AS totals,
              c.loyalty_member_id AS "loyaltyMemberId", c.loyalty_benefit AS "loyaltyBenefit"
         FROM pos_checks c JOIN outlets o ON o.id = c.outlet_id JOIN users u ON u.id = c.waiter_id
         JOIN pos_check_totals tot ON tot.check_id = c.id
         LEFT JOIN pos_tables t ON t.id = c.table_id
         LEFT JOIN stays s ON s.id = c.stay_id LEFT JOIN rooms rm ON rm.id = s.room_id LEFT JOIN guests g ON g.id = s.primary_guest_id
        WHERE c.property_id = $1 AND c.id = $2`,
      [propertyId, checkId],
    );
    if (!rows[0]) throw new NotFoundException('Check not found at this property');
    const { rows: lines } = await q.query(
      `SELECT l.id, l.name, l.quantity::text AS quantity, l.unit_price AS "unitPrice", l.modifiers, l.modifiers_unit_price AS "modifiersUnitPrice",
              l.rule_percent::text AS "rulePercent", l.rule_discount AS "ruleDiscount", l.discount_percent::text AS "discountPercent",
              l.discount_amount AS "discountAmount", l.discount_reason AS "discountReason", l.is_comp AS "isComp",
              l.amount, l.net_amount AS "netAmount", l.tax_amount AS "taxAmount", l.taxes, l.notes, l.status, l.route, l.is_alcohol AS "isAlcohol",
              l.charge_code AS "chargeCode", tk.number AS "ticketNumber", l.added_at AS "addedAt", l.sent_at AS "sentAt", l.served_at AS "servedAt",
              l.cancel_reason AS "cancelReason", au.display_name AS "addedBy", l.liquor_override_id IS NOT NULL AS "liquorOverride",
              l.member_discount_percent::text AS "memberDiscountPercent", l.member_discount_amount AS "memberDiscountAmount",
              l.reward_amount AS "rewardAmount", l.reward_points AS "rewardPoints", l.reward_wallet AS "rewardWallet",
              coalesce((SELECT sum(rl.quantity) FROM pos_return_lines rl WHERE rl.line_id = l.id), 0)::text AS "returnedQuantity"
         FROM pos_check_lines l LEFT JOIN pos_tickets tk ON tk.id = l.ticket_id LEFT JOIN users au ON au.id = l.added_by
        WHERE l.check_id = $1 ORDER BY l.added_at, l.id`,
      [checkId],
    );
    const { rows: payments } = await q.query(
      `SELECT p.id, p.tender, p.amount, p.tendered, (p.tendered - p.amount)::numeric(18,2) AS change, p.reference, p.status,
              p.received_at AS "receivedAt", u.display_name AS "receivedBy", p.failed_reason AS "failedReason",
              coalesce((SELECT sum(r.amount) FROM pos_refunds r WHERE r.payment_id = p.id), 0)::numeric(18,2)::text AS refunded
         FROM pos_payments p LEFT JOIN users u ON u.id = p.received_by WHERE p.check_id = $1 ORDER BY p.received_at`,
      [checkId],
    );
    const { rows: roomCharge } = await q.query(
      `SELECT rc.amount, rc.acknowledgement_method AS "acknowledgementMethod", rc.signed_name AS "signedName", f.number AS "folioNumber",
              s.number AS "stayNumber", rc.posted_at AS "postedAt",
              (SELECT json_agg(fc.id ORDER BY fc.posted_at) FROM folio_charges fc WHERE fc.pos_check_id = rc.check_id) AS "folioChargeIds"
         FROM pos_room_charges rc JOIN folios f ON f.id = rc.folio_id JOIN stays s ON s.id = rc.stay_id WHERE rc.check_id = $1`,
      [checkId],
    );
    const { rows: house } = await q.query(
      `SELECT h.amount, h.reason, ha.code, ha.name FROM house_account_charges h JOIN house_accounts ha ON ha.id = h.house_account_id WHERE h.check_id = $1`,
      [checkId],
    );
    const { rows: refunds } = await q.query(
      `SELECT r.id, r.number, r.tender, r.amount, r.reason, r.created_at AS "createdAt", u.display_name AS "createdBy"
         FROM pos_refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.check_id = $1 ORDER BY r.created_at`,
      [checkId],
    );
    const { rows: returns } = await q.query(
      `SELECT r.id, r.number, r.amount, r.reason, r.points_restored AS "pointsRestored", r.points_reversed AS "pointsReversed",
              r.wallet_restored::text AS "walletRestored", r.created_at AS "createdAt", u.display_name AS "createdBy"
         FROM pos_returns r LEFT JOIN users u ON u.id = r.created_by WHERE r.check_id = $1 ORDER BY r.created_at`,
      [checkId],
    );
    const loyalty = rows[0].loyaltyMemberId ? await this.loyalty.receipt(q, checkId) : null;
    return { ...rows[0], lines, payments, roomCharge: roomCharge[0] ?? null, houseAccount: house[0] ?? null, refunds, returns, loyalty };
  }

  async events(propertyId: string, checkId: string) {
    const { rows } = await this.db.query(
      `SELECT e.id, e.event, e.line_id AS "lineId", e.details, e.occurred_at AS "occurredAt", u.display_name AS actor
         FROM pos_check_events e LEFT JOIN users u ON u.id = e.actor WHERE e.property_id = $1 AND e.check_id = $2 ORDER BY e.id`,
      [propertyId, checkId],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // Opening checks (POS-04, POS-05)
  // -------------------------------------------------------------------------

  async open(propertyId: string, outletCode: string, input: OpenCheckInput) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, outletCode);
      if (!outlet.serviceTypes.includes(input.serviceType)) {
        throw new BadRequestException(`${outlet.name} does not offer ${input.serviceType.replace('_', ' ')}`);
      }
      if (input.tableId) {
        const { rowCount } = await q.query('SELECT 1 FROM pos_tables WHERE id = $1 AND outlet_id = $2 AND is_active', [input.tableId, outlet.id]);
        if (!rowCount) throw new BadRequestException(`That table is not at ${outlet.name}`);
      }
      if (input.serviceType === 'table' && !input.tableId) throw new BadRequestException('Table service needs a table');
      if (input.serviceType === 'room_service' && !input.stayId) throw new BadRequestException('Room service needs the guest’s stay');
      if (input.stayId) await this.inHouseStay(q, propertyId, input.stayId);

      const day = await this.days.currentDay(q, outlet, true);
      const number = await this.numbering.next(propertyId, 'POS_CHECK');
      const actor = actorId();
      try {
        const { rows } = await withSavepoint(q, 'open_check', () =>
          q.query<{ id: string }>(
            `INSERT INTO pos_checks (id, property_id, number, outlet_id, outlet_day_id, business_date, service_type, table_id, tab_name, covers,
                                     waiter_id, stay_id, notes, device_id, opened_by, client_opened_at)
             VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $11, $15)
             RETURNING id`,
            [input.id ?? null, propertyId, number, outlet.id, day!.id, day!.businessDate, input.serviceType, input.tableId ?? null,
             input.tabName?.trim() || null, input.covers ?? 1, actor, input.stayId ?? null, input.notes ?? null, input.deviceId ?? null,
             input.clientOpenedAt ?? null],
          ),
        );
        await event(q, propertyId, rows[0].id, 'opened', { serviceType: input.serviceType, deviceId: input.deviceId ?? null });
        return this.view(q, propertyId, rows[0].id);
      } catch (err) {
        if (isPgError(err, '23505') && input.id) throw conflict('A check with this id already exists', 'duplicate');
        throw err;
      }
    });
  }

  private async inHouseStay(q: Queryable, propertyId: string, stayId: string) {
    const { rows } = await q.query<{ number: string; status: string }>('SELECT number, status::text AS status FROM stays WHERE property_id = $1 AND id = $2', [
      propertyId,
      stayId,
    ]);
    if (!rows[0]) throw new NotFoundException('Stay not found at this property (BIL-17)');
    if (rows[0].status !== 'checked_in') throw conflict(`Stay ${rows[0].number} is ${rows[0].status}; only in-house guests`, 'stay_not_in_house');
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Adding items (POS-02, POS-03, POS-12, POS-17)
  // -------------------------------------------------------------------------

  async addLines(propertyId: string, checkId: string, input: AddLinesInput) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      const outlet = await outletById(q, check.outletId);
      const local = await localNow(q, propertyId);
      const hours = await this.menu.liquorWindows(q, outlet.id);
      const liquorOk = liquorAllowed(hours, local);
      const warnings: string[] = [];
      let liquorOverrideId: string | null = null;

      // Resolve every line before writing anything, so one refusal leaves the check untouched.
      const resolved = [];
      for (const l of input.lines) {
        const { rows } = await q.query<{
          priceRowId: string; itemId: string; name: string; portionName: string; chargeCode: string; isAlcohol: boolean; route: 'kitchen' | 'bar' | 'none';
          price: string; isAvailable: boolean; itemActive: boolean; stockRemaining: string | null; categoryId: string;
        }>(
          `SELECT mp.id AS "priceRowId", mi.id AS "itemId", mi.name, pt.name AS "portionName", mi.charge_code AS "chargeCode",
                  mi.is_alcohol AS "isAlcohol", mc.route, mp.price, mp.is_available AS "isAvailable", mi.is_active AND mc.is_active AS "itemActive",
                  mp.stock_remaining::text AS "stockRemaining", mi.category_id AS "categoryId"
             FROM outlet_menu_prices mp JOIN menu_items mi ON mi.id = mp.item_id JOIN menu_item_portions pt ON pt.id = mp.portion_id
             JOIN menu_categories mc ON mc.id = mi.category_id
            WHERE mp.outlet_id = $1 AND mp.portion_id = $2
            FOR UPDATE OF mp`,
          [outlet.id, l.portionId],
        );
        const item = rows[0];
        if (!item) throw new UnprocessableEntityException(`That item is not on ${outlet.name}’s menu`);
        const name = item.portionName ? `${item.name} (${item.portionName})` : item.name;
        if (!item.itemActive || !item.isAvailable) throw conflict(`${name} is marked unavailable at ${outlet.name}`, 'item_unavailable');
        if (item.stockRemaining !== null && Money.of(l.quantity).compare(item.stockRemaining) > 0) {
          const msg = `Only ${Number(item.stockRemaining)} × ${name} left`;
          if (outlet.stockPolicy === 'block') throw conflict(msg, 'out_of_stock');
          warnings.push(msg);
        }
        if (item.isAlcohol && !liquorOk) {
          if (outlet.liquorPolicy === 'warn') warnings.push(`${name} is alcohol outside the licensed hours`);
          else if (!liquorOverrideId) {
            if (!input.liquorOverrideReason) {
              throw conflict(`Alcohol cannot be sold at ${outlet.name} now: outside the licensed hours. A manager override with a reason is needed.`, 'liquor_hours', {
                liquorHours: hours,
              });
            }
            liquorOverrideId = await this.approvals.approve({
              permission: 'approve.liquor_override', propertyId, action: 'pos.liquor_override', entityType: 'pos_check', entityId: check.id,
              reason: input.liquorOverrideReason, approval: input.approval, details: { check: check.number, localTime: local },
            });
          }
        }
        const mods = await this.modifiers(q, item.itemId, l.modifierOptionIds ?? []);
        const rule = await this.bestRule(q, propertyId, outlet.id, item.itemId, item.categoryId, local);
        resolved.push({ input: l, item, name, mods, rule, alcoholOutside: item.isAlcohol && !liquorOk });
      }
      if (warnings.length && !input.acknowledgeWarnings) {
        throw conflict(`${warnings.join('; ')}. Confirm to continue.`, 'warning', { warnings });
      }

      for (const r of resolved) {
        const price = priceLine({ unitPrice: r.item.price, modifiersUnitPrice: r.mods.unitPrice, quantity: r.input.quantity, rulePercent: r.rule?.percent ?? '0' });
        const tax = await inclusiveTaxes(q, r.item.chargeCode, price.amount);
        const { rows } = await q.query<{ id: string }>(
          `INSERT INTO pos_check_lines (id, property_id, check_id, item_id, portion_id, name, charge_code, is_alcohol, route, quantity, unit_price,
                                        modifiers, modifiers_unit_price, rule_id, rule_percent, rule_discount, amount, net_amount, tax_amount, taxes,
                                        notes, liquor_override_id, added_by)
           VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
           RETURNING id`,
          [r.input.id ?? null, propertyId, check.id, r.item.itemId, r.input.portionId, r.name, r.item.chargeCode, r.item.isAlcohol, r.item.route,
           r.input.quantity, r.item.price, JSON.stringify(r.mods.snapshot), r.mods.unitPrice, r.rule?.id ?? null, r.rule?.percent ?? '0',
           price.ruleDiscount, tax.gross, tax.net, tax.tax, JSON.stringify(tax.lines), r.input.notes?.trim() || null,
           r.alcoholOutside ? liquorOverrideId : null, actorId()],
        );
        if (r.item.stockRemaining !== null) {
          await q.query('UPDATE outlet_menu_prices SET stock_remaining = greatest(stock_remaining - $2::numeric, 0) WHERE id = $1', [r.item.priceRowId, r.input.quantity]);
        }
        await event(q, propertyId, check.id, 'line_added', { name: r.name, quantity: r.input.quantity, amount: tax.gross, rule: r.rule?.name ?? null }, rows[0].id);
      }
      if (warnings.length) {
        await this.audit.record({ action: 'pos.warning_acknowledged', entityType: 'pos_check', entityId: check.id, propertyId, newValues: { warnings } });
      }
      await this.loyalty.refreshCheck(q, propertyId, check.id);
      return this.view(q, propertyId, check.id);
    });
  }

  private async modifiers(q: Queryable, itemId: string, optionIds: string[]) {
    const { rows: groups } = await q.query<{ id: string; code: string; name: string; minSelect: number; maxSelect: number }>(
      `SELECT g.id, g.code, g.name, g.min_select AS "minSelect", g.max_select AS "maxSelect"
         FROM menu_item_modifier_groups ig JOIN modifier_groups g ON g.id = ig.group_id WHERE ig.item_id = $1`,
      [itemId],
    );
    const { rows: options } = optionIds.length
      ? await q.query<{ id: string; groupId: string; name: string; priceDelta: string }>(
          `SELECT id, group_id AS "groupId", name, price_delta AS "priceDelta" FROM modifier_options WHERE id = ANY($1) AND is_active`,
          [optionIds],
        )
      : { rows: [] };
    if (options.length !== new Set(optionIds).size) throw new BadRequestException('Unknown or inactive modifier');
    for (const o of options) {
      if (!groups.some((g) => g.id === o.groupId)) throw new BadRequestException(`${o.name} is not a modifier of this item`);
    }
    for (const g of groups) {
      const n = options.filter((o) => o.groupId === g.id).length;
      if (n < g.minSelect || n > g.maxSelect) {
        throw new BadRequestException(`${g.name}: choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect} to ${g.maxSelect}`}`);
      }
    }
    return {
      unitPrice: Money.sum(options.map((o) => Money.of(o.priceDelta))).toString(),
      snapshot: options.map((o) => ({ id: o.id, group: groups.find((g) => g.id === o.groupId)!.name, name: o.name, priceDelta: o.priceDelta })),
    };
  }

  private async bestRule(q: Queryable, propertyId: string, outletId: string, itemId: string, categoryId: string, local: string) {
    const { rows } = await q.query<{ id: string; name: string; percent: string; weekdays: number[]; startsAt: string; endsAt: string; validFrom: string; validTo: string | null }>(
      `SELECT id, name, discount_percent::text AS percent, weekdays, to_char(starts_at, 'HH24:MI') AS "startsAt", to_char(ends_at, 'HH24:MI') AS "endsAt",
              valid_from AS "validFrom", valid_to AS "validTo"
         FROM price_rules
        WHERE property_id = $1 AND is_active AND (outlet_id IS NULL OR outlet_id = $2)
          AND (item_id IS NULL OR item_id = $3) AND (category_id IS NULL OR category_id = $4)
        ORDER BY discount_percent DESC`,
      [propertyId, outletId, itemId, categoryId],
    );
    return rows.find((r) => ruleApplies(r, local)) ?? null;
  }

  // -------------------------------------------------------------------------
  // Kitchen and bar tickets (POS-06, POS-07)
  // -------------------------------------------------------------------------

  async send(propertyId: string, checkId: string) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      const tickets = await this.sendDrafts(q, check);
      if (!tickets.sent) throw conflict('There is nothing new to send', 'nothing_to_send');
      return { ...(await this.view(q, propertyId, check.id)), tickets: tickets.tickets };
    });
  }

  /** Sends every draft line: kitchen and bar items as tickets to their stations; items with no station are handed over at once. */
  async sendDrafts(q: Queryable, check: LockedCheck): Promise<{ sent: number; tickets: Array<{ id: string; number: string; route: string; station: string | null }> }> {
    const drafts = await this.lines(q, check.id, `status = 'draft'`);
    if (!drafts.length) return { sent: 0, tickets: [] };
    const tickets = [];
    const direct = drafts.filter((l) => l.route === 'none');
    if (direct.length) {
      await q.query(`UPDATE pos_check_lines SET status = 'served', sent_at = now(), served_at = now() WHERE id = ANY($1)`, [direct.map((l) => l.id)]);
    }
    for (const route of ['kitchen', 'bar'] as const) {
      const lines = drafts.filter((l) => l.route === route);
      if (!lines.length) continue;
      const ticket = await this.createTicket(q, check, route, 'order', lines);
      await q.query(`UPDATE pos_check_lines SET status = 'sent', sent_at = now(), ticket_id = $2 WHERE id = ANY($1)`, [lines.map((l) => l.id), ticket.id]);
      tickets.push(ticket);
    }
    await event(q, check.propertyId, check.id, 'sent', { lines: drafts.length, tickets: tickets.map((t) => t.number) });
    return { sent: drafts.length, tickets };
  }

  private async createTicket(q: Queryable, check: LockedCheck, route: 'kitchen' | 'bar', kind: 'order' | 'cancellation', lines: LineRow[], reason?: string) {
    const { rows: [head] } = await q.query<{
      outletCode: string; outletName: string; tableCode: string | null; roomNumber: string | null; guestName: string | null; server: string;
      stationId: string | null; stationCode: string | null; stationName: string | null; printerName: string | null; local: string;
    }>(
      `SELECT o.code AS "outletCode", o.name AS "outletName", t.code AS "tableCode", rm.number AS "roomNumber",
              CASE WHEN g.id IS NULL THEN NULL ELSE g.first_name || ' ' || left(g.last_name, 1) || '.' END AS "guestName",
              u.display_name AS server, st.id AS "stationId", st.code AS "stationCode", st.name AS "stationName", st.printer_name AS "printerName",
              to_char(now() AT TIME ZONE p.timezone, 'YYYY-MM-DD HH24:MI') AS local
         FROM pos_checks c JOIN outlets o ON o.id = c.outlet_id JOIN properties p ON p.id = c.property_id JOIN users u ON u.id = c.waiter_id
         LEFT JOIN pos_tables t ON t.id = c.table_id
         LEFT JOIN stays s ON s.id = c.stay_id LEFT JOIN rooms rm ON rm.id = s.room_id LEFT JOIN guests g ON g.id = s.primary_guest_id
         LEFT JOIN outlet_station_routes r ON r.outlet_id = c.outlet_id AND r.route = $2
         LEFT JOIN pos_stations st ON st.id = r.station_id AND st.is_active
        WHERE c.id = $1`,
      [check.id, route],
    );
    const number = await this.numbering.next(check.propertyId, 'POS_TICKET');
    const content = {
      kind,
      outlet: { code: head.outletCode, name: head.outletName },
      station: head.stationCode ? { code: head.stationCode, name: head.stationName, printerName: head.printerName } : null,
      checkNumber: check.number,
      serviceType: check.serviceType,
      table: head.tableCode,
      tab: check.tabName,
      room: head.roomNumber,
      guest: head.guestName,
      covers: check.covers,
      server: head.server,
      time: head.local,
      businessDate: check.businessDate,
      reason: reason ?? null,
      lines: lines.map((l) => ({ lineId: l.id, quantity: l.quantity, name: l.name, modifiers: (l.modifiers ?? []).map((m) => m.name), notes: l.notes })),
    };
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO pos_tickets (property_id, number, check_id, station_id, route, kind, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [check.propertyId, number, check.id, head.stationId, route, kind, JSON.stringify(content), actorId()],
    );
    await q.query('INSERT INTO pos_ticket_prints (ticket_id, property_id, print_no, printed_by) VALUES ($1, $2, 1, $3)', [rows[0].id, check.propertyId, actorId()]);
    return { id: rows[0].id, number, route, station: head.stationCode };
  }

  /** Open tickets for a station (POS-07; the full kitchen display is POS-14, P2). */
  async stationTickets(propertyId: string, stationCode: string, includeDone = false) {
    return this.db.tx(async (q) => {
      const { rows: st } = await q.query<{ id: string }>('SELECT id FROM pos_stations WHERE property_id = $1 AND code = $2', [propertyId, stationCode.toUpperCase()]);
      if (!st[0]) throw new NotFoundException(`Station ${stationCode} not found at this property`);
      const { rows } = await q.query(
        `SELECT t.id, t.number, t.kind, t.status, t.route, t.content, t.created_at AS "createdAt", t.updated_at AS "updatedAt",
                (SELECT max(print_no) FROM pos_ticket_prints p WHERE p.ticket_id = t.id) AS prints,
                coalesce((SELECT json_agg(json_build_object('id', l.id, 'status', l.status)) FROM pos_check_lines l WHERE l.ticket_id = t.id), '[]') AS "lineStatuses"
           FROM pos_tickets t
          WHERE t.station_id = $1 AND ($2 OR t.status <> 'done') AND t.created_at > now() - interval '2 days'
          ORDER BY t.created_at`,
        [st[0].id, includeDone],
      );
      return rows;
    });
  }

  /** Kitchen/bar bump: preparing → ready → done. Lines follow (POS-06). */
  async ticketStatus(propertyId: string, ticketId: string, status: 'preparing' | 'ready' | 'done') {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; checkId: string; status: string; kind: string; number: string }>(
        `SELECT id, check_id AS "checkId", status, kind, number FROM pos_tickets WHERE property_id = $1 AND id = $2 FOR UPDATE`,
        [propertyId, ticketId],
      );
      const t = rows[0];
      if (!t) throw new NotFoundException('Ticket not found at this property');
      const order = ['new', 'preparing', 'ready', 'done'];
      if (order.indexOf(status) <= order.indexOf(t.status)) throw conflict(`Ticket ${t.number} is already ${t.status}`, 'invalid_transition');
      await q.query('UPDATE pos_tickets SET status = $2 WHERE id = $1', [t.id, status]);
      if (t.kind === 'order' && status !== 'done') {
        const from = status === 'preparing' ? `('sent')` : `('sent', 'preparing')`;
        const { rowCount } = await q.query(
          `UPDATE pos_check_lines l SET status = $2 FROM pos_checks c
            WHERE l.ticket_id = $1 AND l.status IN ${from} AND c.id = l.check_id AND c.status = 'open'`,
          [t.id, status],
        );
        if (rowCount) await event(q, propertyId, t.checkId, status, { ticket: t.number, lines: rowCount });
      }
      return { id: t.id, number: t.number, status };
    });
  }

  /** Reprints are numbered and labelled REPRINT on the ticket (POS-07). */
  async reprint(propertyId: string, ticketId: string, reason: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; checkId: string; number: string }>(
        'SELECT id, check_id AS "checkId", number FROM pos_tickets WHERE property_id = $1 AND id = $2 FOR UPDATE',
        [propertyId, ticketId],
      );
      if (!rows[0]) throw new NotFoundException('Ticket not found at this property');
      const { rows: [n] } = await q.query<{ next: number }>('SELECT coalesce(max(print_no), 0) + 1 AS next FROM pos_ticket_prints WHERE ticket_id = $1', [ticketId]);
      await q.query('INSERT INTO pos_ticket_prints (ticket_id, property_id, print_no, reason, printed_by) VALUES ($1, $2, $3, $4, $5)', [
        ticketId, propertyId, n.next, reason, actorId(),
      ]);
      await event(q, propertyId, rows[0].checkId, 'ticket_reprinted', { ticket: rows[0].number, printNo: n.next, reason });
      return this.ticket(q, propertyId, ticketId, n.next);
    });
  }

  async ticket(q: Queryable, propertyId: string, ticketId: string, printNo?: number) {
    const { rows } = await q.query<{ id: string; number: string; kind: string; status: string; content: Record<string, unknown>; prints: number }>(
      `SELECT t.id, t.number, t.kind, t.status, t.content,
              (SELECT max(print_no) FROM pos_ticket_prints p WHERE p.ticket_id = t.id) AS prints
         FROM pos_tickets t WHERE t.property_id = $1 AND t.id = $2`,
      [propertyId, ticketId],
    );
    if (!rows[0]) throw new NotFoundException('Ticket not found at this property');
    return { ...rows[0], printNo: printNo ?? rows[0].prints };
  }

  ticketFor(propertyId: string, ticketId: string) {
    return this.db.tx((q) => this.ticket(q, propertyId, ticketId));
  }

  /** The waiter hands items to the guest (POS-06). */
  async serve(propertyId: string, checkId: string, lineIds?: string[]) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      const { rowCount } = await q.query(
        `UPDATE pos_check_lines SET status = 'served', served_at = now()
          WHERE check_id = $1 AND status IN ('sent', 'preparing', 'ready') AND ($2::uuid[] IS NULL OR id = ANY($2))`,
        [check.id, lineIds?.length ? lineIds : null],
      );
      if (!rowCount) throw conflict('Nothing to serve: send items first', 'nothing_to_serve');
      await event(q, propertyId, check.id, 'served', { lines: rowCount });
      return this.view(q, propertyId, check.id);
    });
  }

  // -------------------------------------------------------------------------
  // Discounts and comps (POS-03, SEC-02)
  // -------------------------------------------------------------------------

  async discount(propertyId: string, checkId: string, input: { lineIds?: string[]; percent: string; reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      const lines = (await this.lines(q, check.id, `status NOT IN ('cancelled', 'wasted')`)).filter((l) => !input.lineIds?.length || input.lineIds.includes(l.id));
      if (!lines.length) throw new BadRequestException('No items to discount');
      const pct = Money.of(input.percent);
      const { rows: [prop] } = await q.query<{ free: string }>('SELECT pos_discount_free_percent::text AS free FROM properties WHERE id = $1', [propertyId]);
      let approvalId: string | null = null;
      if (pct.equals(100)) {
        approvalId = await this.approvals.approve({
          permission: 'approve.comp', propertyId, action: 'pos.comp', entityType: 'pos_check', entityId: check.id, reason: input.reason,
          approval: input.approval, details: { check: check.number, lines: lines.map((l) => l.name) },
        });
      } else if (pct.compare(prop.free) > 0) {
        approvalId = await this.approvals.approve({
          permission: 'approve.discount', propertyId, action: 'pos.discount', entityType: 'pos_check', entityId: check.id, reason: input.reason,
          approval: input.approval, details: { check: check.number, percent: pct.toString(), lines: lines.map((l) => l.name) },
        });
      }
      for (const l of lines) await this.reprice(q, l, l.quantity, pct.toString(), pct.isZero() ? null : input.reason, approvalId);
      await this.loyalty.refreshCheck(q, propertyId, check.id);
      await event(q, propertyId, check.id, pct.equals(100) ? 'comped' : 'discounted', { percent: pct.toString(), reason: input.reason, lines: lines.map((l) => l.id) });
      return this.view(q, propertyId, check.id);
    });
  }

  /** Recomputes one line's amounts and taxes from its price snapshot. */
  private async reprice(q: Queryable, l: LineRow, quantity: string, discountPercent: string, reason: string | null, approvalId: string | null) {
    const price = priceLine({ unitPrice: l.unitPrice, modifiersUnitPrice: l.modifiersUnitPrice, quantity, rulePercent: l.rulePercent, discountPercent });
    const tax = await inclusiveTaxes(q, l.chargeCode, price.amount);
    const comp = Money.of(discountPercent).equals(100);
    await q.query(
      `UPDATE pos_check_lines SET quantity = $2, rule_discount = $3, discount_percent = $4::numeric, discount_amount = $5::numeric,
              discount_reason = CASE WHEN $5::numeric = 0 THEN NULL ELSE coalesce($6, discount_reason, 'Discount') END,
              discount_approval_id = coalesce($7, CASE WHEN $4::numeric = 0 THEN NULL ELSE discount_approval_id END),
              is_comp = $8, amount = $9, net_amount = $10, tax_amount = $11, taxes = $12
        WHERE id = $1`,
      [l.id, quantity, price.ruleDiscount, discountPercent, price.discount, reason,
       approvalId, comp, tax.gross, tax.net, tax.tax, JSON.stringify(tax.lines)],
    );
  }

  // -------------------------------------------------------------------------
  // Corrections (POS-11): pre-production cancellation vs waste
  // -------------------------------------------------------------------------

  async cancelLines(propertyId: string, checkId: string, input: { lineIds: string[]; reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      const lines = await this.lines(q, check.id, 'id = ANY($2)', [input.lineIds]);
      if (lines.length !== new Set(input.lineIds).size) throw new NotFoundException('Line not found on this check');
      await this.cancelOrWaste(q, check, lines, input.reason, input.approval);
      await this.loyalty.refreshCheck(q, propertyId, check.id);
      return this.view(q, propertyId, check.id);
    });
  }

  /**
   * Draft lines are removed freely (still recorded). Sent but unprepared lines
   * are cancelled with a manager's approval and their stock count released.
   * Prepared or served lines become waste with approval; stock is not restored
   * (INV-06). Stations get a cancellation ticket for anything they received.
   */
  private async cancelOrWaste(q: Queryable, check: LockedCheck, lines: LineRow[], reason: string, approval?: ApprovalInputT) {
    const final = lines.find((l) => l.status === 'cancelled' || l.status === 'wasted');
    if (final) throw conflict(`${final.name} is already ${final.status}`, 'line_final');
    const sent = lines.filter((l) => l.status === 'sent');
    const prepared = lines.filter((l) => (PREPARED_LINE_STATUSES as readonly string[]).includes(l.status));
    const voidApproval = sent.length
      ? await this.approvals.approve({
          permission: 'approve.void', propertyId: check.propertyId, action: 'pos.line_void', entityType: 'pos_check', entityId: check.id, reason,
          approval, details: { check: check.number, lines: sent.map((l) => `${l.quantity} × ${l.name}`) },
        })
      : null;
    const wasteApproval = prepared.length
      ? await this.approvals.approve({
          permission: 'approve.waste', propertyId: check.propertyId, action: 'pos.line_waste', entityType: 'pos_check', entityId: check.id, reason,
          approval, details: { check: check.number, lines: prepared.map((l) => `${l.quantity} × ${l.name}`) },
        })
      : null;
    for (const l of lines) {
      const waste = prepared.includes(l);
      await q.query(
        `UPDATE pos_check_lines SET status = $2, cancelled_at = now(), cancelled_by = $3, cancel_reason = $4, cancel_approval_id = $5 WHERE id = $1`,
        [l.id, waste ? 'wasted' : 'cancelled', actorId(), reason, waste ? wasteApproval : l.status === 'sent' ? voidApproval : null],
      );
      if (!waste) {
        // Not made: the portion goes back to the outlet's count (POS-12).
        await q.query(
          `UPDATE outlet_menu_prices SET stock_remaining = stock_remaining + $3::numeric
            WHERE outlet_id = $1 AND portion_id = $2 AND stock_remaining IS NOT NULL`,
          [check.outletId, l.portionId, l.quantity],
        );
      }
      await event(q, check.propertyId, check.id, waste ? 'wasted' : 'cancelled', { name: l.name, quantity: l.quantity, reason, was: l.status }, l.id);
    }
    for (const route of ['kitchen', 'bar'] as const) {
      const notify = lines.filter((l) => l.route === route && l.sentAt && l.status !== 'served');
      if (notify.length) await this.createTicket(q, check, route, 'cancellation', notify, reason);
    }
  }

  // -------------------------------------------------------------------------
  // Tables, tabs, transfers, merge and split (POS-05, POS-08)
  // -------------------------------------------------------------------------

  async transfer(propertyId: string, checkId: string, input: { tableId?: string | null; waiterId?: string; tabName?: string | null; covers?: number }) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      if (input.tableId) {
        const { rowCount } = await q.query('SELECT 1 FROM pos_tables WHERE id = $1 AND outlet_id = $2 AND is_active', [input.tableId, check.outletId]);
        if (!rowCount) throw new BadRequestException('That table is not at this outlet');
      }
      if (input.tableId === null && check.serviceType === 'table') throw new BadRequestException('A table-service check needs a table');
      if (input.waiterId) {
        const { rows } = await q.query<{ roles: string[] }>(
          `SELECT coalesce(array_agg(r.role_code), '{}') AS roles FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
            WHERE u.id = $1 AND u.is_active AND (u.all_properties OR EXISTS (SELECT 1 FROM user_property_access a WHERE a.user_id = u.id AND a.property_id = $2))
            GROUP BY u.id`,
          [input.waiterId, propertyId],
        );
        if (!rows[0] || !hasPermission(rows[0].roles, 'pos.use')) throw new BadRequestException('The new server must be active POS staff at this property');
      }
      await q.query(
        `UPDATE pos_checks SET table_id = CASE WHEN $2 THEN $3::uuid ELSE table_id END, waiter_id = coalesce($4, waiter_id),
                tab_name = CASE WHEN $5 THEN $6 ELSE tab_name END, covers = coalesce($7, covers)
          WHERE id = $1`,
        [check.id, input.tableId !== undefined, input.tableId ?? null, input.waiterId ?? null, input.tabName !== undefined, input.tabName?.trim() || null,
         input.covers ?? null],
      );
      await event(q, propertyId, check.id, 'transferred', { from: { tableId: check.tableId, waiterId: check.waiterId, tab: check.tabName }, to: input });
      return this.view(q, propertyId, check.id);
    });
  }

  private async assertNoSettlement(q: Queryable, check: LockedCheck) {
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM pos_payments WHERE check_id = $1 AND status <> 'failed'`, [check.id]);
    if (rows[0].n) throw conflict(`Check ${check.number} already has payments; settle it as it is`, 'check_has_payments');
  }

  async merge(propertyId: string, checkId: string, fromCheckIds: string[]) {
    return this.db.tx(async (q) => {
      const ids = [...new Set([checkId, ...fromCheckIds])].sort();
      if (ids.length < 2) throw new BadRequestException('Choose at least one other check to merge');
      const locked = new Map<string, LockedCheck>();
      for (const id of ids) locked.set(id, await this.lock(q, propertyId, id)); // fixed order: no deadlock
      const target = locked.get(checkId)!;
      for (const id of fromCheckIds) {
        const src = locked.get(id)!;
        if (src.id === target.id) continue;
        if (src.outletId !== target.outletId) throw new BadRequestException(`${src.number} is at another outlet`);
        await this.assertNoSettlement(q, src);
        if (src.stayId && target.stayId && src.stayId !== target.stayId) throw conflict(`${src.number} belongs to another guest stay`, 'stay_mismatch');
        const { rowCount } = await q.query('UPDATE pos_check_lines SET check_id = $2 WHERE check_id = $1', [src.id, target.id]);
        await q.query(
          `UPDATE pos_checks SET status = 'merged', merged_into_id = $2, closed_at = now(), closed_by = $3, finalised_at = now() WHERE id = $1`,
          [src.id, target.id, actorId()],
        );
        if (src.stayId && !target.stayId) await q.query('UPDATE pos_checks SET stay_id = $2 WHERE id = $1', [target.id, src.stayId]);
        await event(q, propertyId, src.id, 'merged_into', { into: target.number, lines: rowCount });
        await event(q, propertyId, target.id, 'merged_from', { from: src.number, lines: rowCount });
        // The merged bill keeps the target's member, or takes the source's if it had none (LOY12).
        await this.loyalty.releaseHolds(q, src.id, 'Merged into another bill');
        if (src.loyaltyMemberId && !target.loyaltyMemberId) {
          await q.query('UPDATE pos_checks SET loyalty_member_id = $2, loyalty_benefit = $3 WHERE id = $1', [target.id, src.loyaltyMemberId, src.loyaltyBenefit]);
          target.loyaltyMemberId = src.loyaltyMemberId;
        }
      }
      await this.loyalty.refreshCheck(q, propertyId, target.id);
      return this.view(q, propertyId, target.id);
    });
  }

  /**
   * Split by item (POS-08): the chosen lines, or part of a line's quantity,
   * move to a new check at the same table. Split by amount is done by paying
   * in parts with several tenders.
   */
  async split(propertyId: string, checkId: string, parts: Array<{ lineId: string; quantity?: string }>) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      await this.assertNoSettlement(q, check);
      const live = await this.lines(q, check.id, `status NOT IN ('cancelled', 'wasted')`);
      if (parts.length === 0) throw new BadRequestException('Choose items to split off');
      const moving = parts.map((p) => {
        const l = live.find((x) => x.id === p.lineId);
        if (!l) throw new NotFoundException('Line not found on this check');
        const qty = Money.of(p.quantity ?? l.quantity);
        if (qty.isNegative() || qty.isZero() || qty.compare(l.quantity) > 0) throw new BadRequestException(`Split quantity for ${l.name} must be between 0 and ${l.quantity}`);
        return { line: l, quantity: p.quantity ?? l.quantity };
      });
      const whole = moving.filter((m) => Money.of(m.quantity).equals(m.line.quantity));
      if (whole.length === live.length && moving.length === live.length) throw new BadRequestException('Leave at least one item on the original check');

      const number = await this.numbering.next(propertyId, 'POS_CHECK');
      const { rows: [created] } = await q.query<{ id: string }>(
        `INSERT INTO pos_checks (property_id, number, outlet_id, outlet_day_id, business_date, service_type, table_id, tab_name, covers, waiter_id, stay_id, opened_by)
         SELECT property_id, $2, outlet_id, outlet_day_id, business_date, service_type, table_id, tab_name, 1, waiter_id, stay_id, $3
           FROM pos_checks WHERE id = $1 RETURNING id`,
        [check.id, number, actorId()],
      );
      for (const m of moving) {
        if (Money.of(m.quantity).equals(m.line.quantity)) {
          await q.query('UPDATE pos_check_lines SET check_id = $2 WHERE id = $1', [m.line.id, created.id]);
          continue;
        }
        // Part of a line: copy it with the split quantity, then reprice both halves.
        const { rows: [copy] } = await q.query<{ id: string }>(
          `INSERT INTO pos_check_lines (property_id, check_id, item_id, portion_id, name, charge_code, is_alcohol, route, quantity, unit_price, modifiers,
                                        modifiers_unit_price, rule_id, rule_percent, rule_discount, discount_percent, discount_amount, discount_reason,
                                        discount_approval_id, is_comp, amount, net_amount, tax_amount, taxes, notes, status, ticket_id, liquor_override_id,
                                        added_by, added_at, sent_at, served_at)
           SELECT property_id, $2, item_id, portion_id, name, charge_code, is_alcohol, route, $3, unit_price, modifiers, modifiers_unit_price, rule_id,
                  rule_percent, 0, discount_percent, 0, discount_reason, discount_approval_id, is_comp, 0, 0, 0, '[]', notes, status, ticket_id,
                  liquor_override_id, added_by, added_at, sent_at, served_at
             FROM pos_check_lines WHERE id = $1 RETURNING id`,
          [m.line.id, created.id, m.quantity],
        );
        const rest = Money.of(m.line.quantity).subtract(m.quantity).toString();
        const [copyRow] = await this.lines(q, created.id, 'id = $2', [copy.id]);
        await this.reprice(q, copyRow, m.quantity, m.line.discountPercent, null, null);
        await this.reprice(q, m.line, rest, m.line.discountPercent, null, null);
      }
      // Both halves keep the member; any reward held is dropped and each bill is re-priced (S06).
      await q.query('UPDATE pos_checks SET loyalty_member_id = $2, loyalty_benefit = $3 WHERE id = $1', [created.id, check.loyaltyMemberId, check.loyaltyBenefit]);
      await this.loyalty.refreshCheck(q, propertyId, check.id);
      await this.loyalty.refreshCheck(q, propertyId, created.id);
      await event(q, propertyId, check.id, 'split', { into: number, lines: moving.map((m) => ({ id: m.line.id, quantity: m.quantity })) });
      await event(q, propertyId, created.id, 'opened', { splitFrom: check.number });
      return { from: await this.view(q, propertyId, check.id), to: await this.view(q, propertyId, created.id) };
    });
  }

  /** Void a whole unpaid check (POS-11): its lines are cancelled or wasted with one manager approval. */
  async void(propertyId: string, checkId: string, input: { reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const check = await this.lock(q, propertyId, checkId);
      await this.assertNoSettlement(q, check);
      const approvalId = await this.approvals.approve({
        permission: 'approve.void', propertyId, action: 'pos.check_void', entityType: 'pos_check', entityId: check.id, reason: input.reason,
        approval: input.approval, details: { check: check.number },
      });
      const live = await this.lines(q, check.id, `status NOT IN ('cancelled', 'wasted')`);
      if (live.length) {
        // The same sign-off covers the lines; each kind of correction is still recorded as its own approval.
        await this.cancelOrWaste(q, check, live, input.reason, input.approval);
      }
      await q.query(
        `UPDATE pos_checks SET status = 'void', void_reason = $2, void_approval_id = $3, closed_at = now(), closed_by = $4, finalised_at = now() WHERE id = $1`,
        [check.id, input.reason, approvalId, actorId()],
      );
      await this.loyalty.releaseHolds(q, check.id, 'Bill voided');
      await event(q, propertyId, check.id, 'voided', { reason: input.reason });
      await this.audit.record({ action: 'pos.check_void', entityType: 'pos_check', entityId: check.id, propertyId, reason: input.reason });
      return this.view(q, propertyId, check.id);
    });
  }
}
