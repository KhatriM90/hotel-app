import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BookingPolicy, Money, priceNight } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';

export interface RatePlanRow {
  id: string;
  code: string;
  name: string;
  isNegotiated: boolean;
  companyId: string | null;
  companyName: string | null;
  weekendDays: number[];
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface RoomTypeRow {
  id: string;
  code: string;
  name: string;
  baseOccupancy: number;
  maxAdults: number;
  maxOccupancy: number;
}

export interface PricedNight {
  date: string;
  base: string;
  supplement: string;
  amount: string;
  seasonName: string | null;
  weekend: boolean;
}

/** Policy as stored on a reservation and used by the pricing rules. */
export interface PolicySnapshot extends BookingPolicy {
  holdMinutes: number;
  refundPolicy: string;
  checkInTime: string;
  checkOutTime: string;
  earlyCheckInFee: string;
  lateCheckOutFee: string;
  registrationTerms: string;
}

const POLICY_COLUMNS = `
  deposit_type AS "depositType", deposit_value::text AS "depositValue", deposit_due_days AS "depositDueDays",
  default_hold_minutes AS "holdMinutes", free_cancellation_hours AS "freeCancellationHours",
  late_cancellation_nights AS "lateCancellationNights", no_show_nights AS "noShowNights",
  refund_policy AS "refundPolicy", to_char(check_in_time, 'HH24:MI') AS "checkInTime",
  to_char(check_out_time, 'HH24:MI') AS "checkOutTime", early_check_in_fee AS "earlyCheckInFee",
  late_check_out_fee AS "lateCheckOutFee", registration_terms AS "registrationTerms"`;

const PLAN_COLUMNS = `
  rp.id, rp.code, rp.name, rp.is_negotiated AS "isNegotiated", rp.company_id AS "companyId", c.name AS "companyName",
  rp.weekend_days AS "weekendDays", rp.effective_from AS "effectiveFrom", rp.effective_to AS "effectiveTo",
  rp.is_active AS "isActive"`;

export interface NewPriceInput {
  roomTypeCode: string;
  seasonName: string;
  validFrom: string;
  validTo?: string | null;
  priority: number;
  weekdayPrice: string;
  weekendPrice: string;
  extraAdultPrice: string;
  childPrice: string;
}

export type PolicyInput = Partial<Omit<PolicySnapshot, 'depositType'>> & { depositType?: BookingPolicy['depositType'] };

/** Rate plans, seasonal prices and booking policies (RES-05, RES-07). */
@Injectable()
export class RatesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async roomType(q: Queryable, propertyId: string, code: string): Promise<RoomTypeRow> {
    const { rows } = await q.query<RoomTypeRow>(
      `SELECT id, code, name, base_occupancy AS "baseOccupancy", max_adults AS "maxAdults", max_occupancy AS "maxOccupancy"
         FROM room_types WHERE property_id = $1 AND code = $2 AND is_active`,
      [propertyId, code.toUpperCase()],
    );
    if (!rows[0]) throw new UnprocessableEntityException(`Unknown room type ${code}`);
    return rows[0];
  }

  async roomTypeById(q: Queryable, id: string): Promise<RoomTypeRow> {
    const { rows } = await q.query<RoomTypeRow>(
      `SELECT id, code, name, base_occupancy AS "baseOccupancy", max_adults AS "maxAdults", max_occupancy AS "maxOccupancy"
         FROM room_types WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async ratePlan(q: Queryable, propertyId: string, code: string): Promise<RatePlanRow> {
    const { rows } = await q.query<RatePlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM rate_plans rp LEFT JOIN companies c ON c.id = rp.company_id
        WHERE rp.property_id = $1 AND rp.code = $2 AND rp.is_active`,
      [propertyId, code.toUpperCase()],
    );
    if (!rows[0]) throw new UnprocessableEntityException(`Unknown rate plan ${code}`);
    return rows[0];
  }

  async ratePlanById(q: Queryable, id: string): Promise<RatePlanRow> {
    const { rows } = await q.query<RatePlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM rate_plans rp LEFT JOIN companies c ON c.id = rp.company_id WHERE rp.id = $1`,
      [id],
    );
    return rows[0];
  }

  checkOccupancy(type: RoomTypeRow, adults: number, children: number): void {
    if (adults > type.maxAdults || adults + children > type.maxOccupancy) {
      throw new UnprocessableEntityException(
        `${type.name} takes at most ${type.maxAdults} adults and ${type.maxOccupancy} guests in total`,
      );
    }
  }

  /**
   * Current price of each night (RES-05): the matching price row with the
   * highest priority (seasons over base), then the latest. Every night must be
   * priced, or the booking is refused with the first unpriced date.
   */
  async priceNights(
    q: Queryable,
    plan: RatePlanRow,
    type: RoomTypeRow,
    nights: string[],
    adults: number,
    children: number,
  ): Promise<PricedNight[]> {
    if (nights.length === 0) return [];
    const { rows } = await q.query<{
      night: string;
      season_name: string | null;
      weekday_price: string | null;
      weekend_price: string;
      extra_adult_price: string;
      child_price: string;
    }>(
      `SELECT n.night::text AS night, p.season_name, p.weekday_price, p.weekend_price, p.extra_adult_price, p.child_price
         FROM unnest($3::date[]) AS n(night)
         LEFT JOIN LATERAL (
           SELECT season_name, weekday_price, weekend_price, extra_adult_price, child_price
             FROM rate_prices
            WHERE rate_plan_id = $1 AND room_type_id = $2
              AND valid_from <= n.night AND (valid_to IS NULL OR valid_to > n.night)
            ORDER BY priority DESC, valid_from DESC, created_at DESC
            LIMIT 1
         ) p ON true
        ORDER BY n.night`,
      [plan.id, type.id, nights],
    );
    return rows.map((r) => {
      const outsidePlan = r.night < plan.effectiveFrom || (plan.effectiveTo !== null && r.night >= plan.effectiveTo);
      if (r.weekday_price === null || outsidePlan) {
        throw new UnprocessableEntityException(`Rate plan ${plan.code} has no ${type.code} price for the night of ${r.night}`);
      }
      const p = priceNight(
        {
          weekdayPrice: r.weekday_price,
          weekendPrice: r.weekend_price,
          extraAdultPrice: r.extra_adult_price,
          childPrice: r.child_price,
          weekendDays: plan.weekendDays,
          baseOccupancy: type.baseOccupancy,
        },
        r.night,
        adults,
        children,
      );
      return { date: p.date, base: p.base, supplement: p.supplement, amount: p.amount, weekend: p.weekend, seasonName: r.season_name };
    });
  }

  async policy(q: Queryable, propertyId: string): Promise<PolicySnapshot> {
    const { rows } = await q.query<PolicySnapshot>(`SELECT ${POLICY_COLUMNS} FROM booking_policies WHERE property_id = $1`, [propertyId]);
    if (!rows[0]) throw new NotFoundException('No booking policy for this property');
    return rows[0];
  }

  getPolicy(propertyId: string): Promise<PolicySnapshot> {
    return this.db.tx((q) => this.policy(q, propertyId));
  }

  async updatePolicy(propertyId: string, input: PolicyInput): Promise<PolicySnapshot> {
    const map: Record<string, string> = {
      depositType: 'deposit_type',
      depositValue: 'deposit_value',
      depositDueDays: 'deposit_due_days',
      holdMinutes: 'default_hold_minutes',
      freeCancellationHours: 'free_cancellation_hours',
      lateCancellationNights: 'late_cancellation_nights',
      noShowNights: 'no_show_nights',
      refundPolicy: 'refund_policy',
      checkInTime: 'check_in_time',
      checkOutTime: 'check_out_time',
      earlyCheckInFee: 'early_check_in_fee',
      lateCheckOutFee: 'late_check_out_fee',
      registrationTerms: 'registration_terms',
    };
    const entries = Object.entries(input).filter(([k, v]) => v !== undefined && map[k]);
    if (!entries.length) throw new BadRequestException('Nothing to update');
    return this.db.tx(async (q) => {
      const before = await this.policy(q, propertyId);
      const sets = entries.map(([k], i) => `${map[k]} = $${i + 3}`);
      await q.query(`UPDATE booking_policies SET ${sets.join(', ')}, updated_by = $2 WHERE property_id = $1`, [
        propertyId,
        requestContext.get()?.user?.id ?? null,
        ...entries.map(([, v]) => v),
      ]);
      const after = await this.policy(q, propertyId);
      await this.audit.record({ action: 'policy.update', entityType: 'booking_policy', entityId: propertyId, propertyId, previousValues: before, newValues: after });
      return after;
    });
  }

  async listPlans(propertyId: string) {
    return this.db.tx(async (q) => {
      const { rows: plans } = await q.query<RatePlanRow>(
        `SELECT ${PLAN_COLUMNS} FROM rate_plans rp LEFT JOIN companies c ON c.id = rp.company_id
          WHERE rp.property_id = $1 ORDER BY rp.is_negotiated, rp.code`,
        [propertyId],
      );
      const { rows: prices } = await q.query<{ ratePlanId: string } & Record<string, unknown>>(
        `SELECT p.id, p.rate_plan_id AS "ratePlanId", t.code AS "roomTypeCode", t.name AS "roomTypeName", p.season_name AS "seasonName",
                p.valid_from AS "validFrom", p.valid_to AS "validTo", p.priority, p.weekday_price AS "weekdayPrice",
                p.weekend_price AS "weekendPrice", p.extra_adult_price AS "extraAdultPrice", p.child_price AS "childPrice"
           FROM rate_prices p JOIN room_types t ON t.id = p.room_type_id
          WHERE p.property_id = $1
          ORDER BY t.sort_order, p.priority, p.valid_from`,
        [propertyId],
      );
      return plans.map((plan) => ({ ...plan, prices: prices.filter((p) => p.ratePlanId === plan.id) }));
    });
  }

  /** Prices are never edited; a change is a new row (RES-05). */
  async addPrice(propertyId: string, planCode: string, input: NewPriceInput) {
    if (Money.of(input.weekdayPrice).isNegative() || Money.of(input.weekendPrice).isNegative()) {
      throw new BadRequestException('Prices must not be negative');
    }
    return this.db.tx(async (q) => {
      const plan = await this.ratePlan(q, propertyId, planCode);
      const type = await this.roomType(q, propertyId, input.roomTypeCode);
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO rate_prices (property_id, rate_plan_id, room_type_id, season_name, valid_from, valid_to, priority,
                                  weekday_price, weekend_price, extra_adult_price, child_price, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          propertyId, plan.id, type.id, input.seasonName, input.validFrom, input.validTo ?? null, input.priority,
          input.weekdayPrice, input.weekendPrice, input.extraAdultPrice, input.childPrice, requestContext.get()?.user?.id ?? null,
        ],
      );
      await this.audit.record({ action: 'rate_price.create', entityType: 'rate_price', entityId: rows[0].id, propertyId, newValues: { plan: plan.code, ...input } });
      return { id: rows[0].id, ratePlanCode: plan.code, ...input };
    });
  }

  async quote(propertyId: string, input: { roomTypeCode: string; ratePlanCode: string; nights: string[]; adults: number; children: number }) {
    return this.db.tx(async (q) => {
      const type = await this.roomType(q, propertyId, input.roomTypeCode);
      const plan = await this.ratePlan(q, propertyId, input.ratePlanCode);
      this.checkOccupancy(type, input.adults, input.children);
      const nights = await this.priceNights(q, plan, type, input.nights, input.adults, input.children);
      return { roomType: type.code, ratePlan: plan.code, nights, total: Money.sum(nights.map((n) => Money.of(n.amount))).toString() };
    });
  }
}
