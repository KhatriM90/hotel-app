import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ClubRates, DEFAULT_LOYALTY_SETTINGS, LoyaltySettings, resolveClubRates } from '@hotel/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { actorId } from '../pos/common';

const Pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100, 'at most 100');
const Amt = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);
const Codes = z.array(z.string().regex(/^[A-Za-z0-9_-]{2,24}$/)).max(200);

/** Full programme settings (LOY01 "configure rates, exclusions, rounding and minimum redemption"). */
export const SettingsSchema = z.object({
  points: z.object({
    earnUnit: Amt.refine((v) => Number(v) > 0, 'must be more than 0'),
    pointValue: Amt.refine((v) => Number(v) > 0, 'must be more than 0'),
    minRedeemPoints: z.number().int().min(0).max(1_000_000),
    redeemCapPercent: Pct,
    expiryMonths: z.number().int().min(1).max(120),
    restoreGraceDays: z.number().int().min(0).max(365),
    dailyEarnCap: z.number().int().min(1).max(10_000_000).nullable(),
  }),
  eligibility: z.object({
    basis: z.enum(['net', 'gross']),
    excludedChargeCodes: Codes,
    excludedCategoryCodes: Codes,
    excludedItemCodes: Codes,
    participatingOutletCodes: Codes,
    rewardsOnAlcohol: z.boolean(),
  }),
  rooms: z.object({
    earningSources: z.array(z.enum(['walk_in', 'phone', 'email', 'agent', 'website', 'other'])).max(6),
    corporateEarns: z.boolean(),
    excludedRatePlanCodes: Codes,
  }),
  stacking: z.object({ enabled: z.boolean(), ceilingPercent: Pct }),
  club: z.object({
    defaultDiscountPercent: Pct,
    defaultCashbackPercent: Pct,
    benefitWhenNotStacking: z.enum(['discount', 'cashback']),
    earnsPoints: z.boolean(),
    minMonthlySpend: Amt,
    monthlyCap: Amt.nullable(),
    walletCapPercent: Pct,
    walletExpiryMonths: z.number().int().min(1).max(120),
  }),
  verification: z.object({
    otpDelivery: z.enum(['screen', 'sms']),
    otpMinutes: z.number().int().min(1).max(30),
    maxAttempts: z.number().int().min(1).max(10),
  }),
  reservationMinutes: z.number().int().min(1).max(120),
  misuse: z.object({
    staffEarnsOnOwnBills: z.boolean(),
    billsPerDayAlert: z.number().int().min(2).max(100),
    waiterSharePercentAlert: z.number().int().min(10).max(100),
  }),
  rewardTreatment: z.enum(['discount', 'tender']),
  sapAccounts: z.object({ cashbackExpense: z.string().max(30), walletLiability: z.string().max(30) }),
});

/** Merges stored (possibly older, shorter) settings over the defaults, one level deep. */
export function withDefaults(stored: unknown): LoyaltySettings {
  const s = (stored ?? {}) as Record<string, unknown>;
  const d = DEFAULT_LOYALTY_SETTINGS as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as object), ...((s[k] as object) ?? {}) } : (s[k] ?? v);
  }
  return SettingsSchema.parse(merged) as LoyaltySettings;
}

export interface ProgrammeVersion {
  id: string;
  version: number;
  effectiveFrom: string;
  settings: LoyaltySettings;
  note: string;
}

/**
 * Programme rules and club rates (LOY01, CLUB01). Every change is a new
 * version with an effective date, recorded with who made it; each sale stores
 * the version it used, so later changes never recalculate earlier purchases.
 */
@Injectable()
export class LoyaltyProgrammeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** The version in force at a moment (default now). */
  async current(q: Queryable, at?: string): Promise<ProgrammeVersion> {
    const { rows } = await q.query<{ id: string; version: number; effectiveFrom: string; settings: unknown; note: string }>(
      `SELECT id, version, effective_from AS "effectiveFrom", settings, note FROM loyalty_programme_versions
        WHERE effective_from <= coalesce($1::timestamptz, now()) ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [at ?? null],
    );
    if (!rows[0]) throw new NotFoundException('No loyalty programme version is in force');
    return { ...rows[0], settings: withDefaults(rows[0].settings) };
  }

  async byId(q: Queryable, id: string): Promise<ProgrammeVersion> {
    const { rows } = await q.query<{ id: string; version: number; effectiveFrom: string; settings: unknown; note: string }>(
      `SELECT id, version, effective_from AS "effectiveFrom", settings, note FROM loyalty_programme_versions WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Programme version not found');
    return { ...rows[0], settings: withDefaults(rows[0].settings) };
  }

  async overview() {
    return this.db.tx(async (q) => {
      const current = await this.current(q);
      const { rows: versions } = await q.query(
        `SELECT v.id, v.version, v.effective_from AS "effectiveFrom", v.note, v.created_at AS "createdAt", u.display_name AS "createdBy",
                v.effective_from > now() AS scheduled, v.settings
           FROM loyalty_programme_versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.version DESC`,
      );
      return {
        current,
        versions: versions.map((v) => ({ ...v, settings: withDefaults(v.settings) })),
        tiers: await this.tiers(q),
      };
    });
  }

  /**
   * A new version from now or a future date; never backdated, so a rule change
   * applies prospectively and refunds keep the rules of their sale (LOY14).
   */
  async createVersion(input: { settings: LoyaltySettings; effectiveFrom?: string | null; note: string }) {
    return this.db.tx(async (q) => {
      const settings = SettingsSchema.parse(input.settings) as LoyaltySettings;
      const effective = input.effectiveFrom ?? null;
      if (effective && new Date(effective).getTime() < Date.now() - 60_000) throw new BadRequestException('A programme change cannot be backdated');
      await q.query("SELECT pg_advisory_xact_lock(hashtext('loyalty_programme_versions'))");
      const { rows: [v] } = await q.query<{ id: string; version: number; effectiveFrom: string }>(
        `INSERT INTO loyalty_programme_versions (version, effective_from, settings, note, created_by)
         SELECT coalesce(max(version), 0) + 1, coalesce($1::timestamptz, now()), $2, $3, $4 FROM loyalty_programme_versions
         RETURNING id, version, effective_from AS "effectiveFrom"`,
        [effective, JSON.stringify(settings), input.note, actorId()],
      );
      const before = await this.current(q, new Date(new Date(v.effectiveFrom).getTime() - 1).toISOString()).catch(() => null);
      await this.audit.record({
        action: 'loyalty.programme_version', entityType: 'loyalty_programme', entityId: v.id, reason: input.note,
        previousValues: before ? { version: before.version, settings: before.settings } : null, newValues: { version: v.version, effectiveFrom: v.effectiveFrom, settings },
      });
      return v;
    });
  }

  // -------------------------------------------------------------------------
  // Club tiers and rates (CLUB01)
  // -------------------------------------------------------------------------

  async tiers(q: Queryable) {
    const { rows } = await q.query(
      `SELECT t.code, t.name, t.is_active AS "isActive", r.discount_percent::text AS "discountPercent", r.cashback_percent::text AS "cashbackPercent",
              r.effective_from AS "effectiveFrom",
              (SELECT json_agg(json_build_object('discountPercent', h.discount_percent::text, 'cashbackPercent', h.cashback_percent::text,
                                                 'effectiveFrom', h.effective_from, 'reason', h.reason) ORDER BY h.effective_from DESC)
                 FROM club_tier_rates h WHERE h.tier_code = t.code) AS history,
              (SELECT count(*)::int FROM club_memberships m WHERE m.tier_code = t.code AND m.status = 'active') AS members
         FROM club_tiers t
         LEFT JOIN LATERAL (SELECT * FROM club_tier_rates x WHERE x.tier_code = t.code AND x.effective_from <= now()
                             ORDER BY x.effective_from DESC LIMIT 1) r ON true
        ORDER BY t.sort_order`,
    );
    return rows;
  }

  async setTierRate(code: string, input: { discountPercent: string | null; cashbackPercent: string | null; effectiveFrom?: string | null; reason: string }) {
    return this.db.tx(async (q) => {
      const { rowCount } = await q.query('SELECT 1 FROM club_tiers WHERE code = $1', [code]);
      if (!rowCount) throw new NotFoundException(`Club tier ${code} not found`);
      if (input.effectiveFrom && new Date(input.effectiveFrom).getTime() < Date.now() - 60_000) throw new BadRequestException('A rate change cannot be backdated');
      await q.query(
        `INSERT INTO club_tier_rates (tier_code, discount_percent, cashback_percent, effective_from, reason, created_by)
         VALUES ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6)`,
        [code, input.discountPercent, input.cashbackPercent, input.effectiveFrom ?? null, input.reason, actorId()],
      );
      await this.audit.record({ action: 'loyalty.club_tier_rate', entityType: 'club_tier', entityId: code, reason: input.reason, newValues: input });
      return this.tiers(q);
    });
  }

  /**
   * A member's club rates at a moment (CLUB01): approved override, then tier,
   * then programme default. Null when the member is not an active club member
   * then; suspended or expired members get no new benefits.
   */
  async clubRates(q: Queryable, memberId: string, at: string, settings: LoyaltySettings): Promise<(ClubRates & { tierCode: string }) | null> {
    const day = at.slice(0, 10);
    const { rows: [m] } = await q.query<{ tierCode: string; status: string; startsOn: string; endsOn: string | null }>(
      `SELECT tier_code AS "tierCode", status, starts_on AS "startsOn", ends_on AS "endsOn" FROM club_memberships WHERE member_id = $1`,
      [memberId],
    );
    if (!m || m.status !== 'active' || m.startsOn > day || (m.endsOn && m.endsOn < day)) return null;
    const { rows: [tier] } = await q.query<{ discountPercent: string | null; cashbackPercent: string | null }>(
      `SELECT discount_percent::text AS "discountPercent", cashback_percent::text AS "cashbackPercent" FROM club_tier_rates
        WHERE tier_code = $1 AND effective_from <= $2::timestamptz ORDER BY effective_from DESC LIMIT 1`,
      [m.tierCode, at.length === 10 ? `${at}T23:59:59+03:00` : at],
    );
    const { rows: [override] } = await q.query<{ discountPercent: string | null; cashbackPercent: string | null }>(
      `SELECT discount_percent::text AS "discountPercent", cashback_percent::text AS "cashbackPercent" FROM club_rate_overrides
        WHERE member_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
      [memberId, day],
    );
    const rates = resolveClubRates(override ?? null, tier ?? null, {
      discountPercent: settings.club.defaultDiscountPercent,
      cashbackPercent: settings.club.defaultCashbackPercent,
    });
    return { ...rates, discountPercent: Number(rates.discountPercent).toFixed(2), cashbackPercent: Number(rates.cashbackPercent).toFixed(2), tierCode: m.tierCode };
  }
}
