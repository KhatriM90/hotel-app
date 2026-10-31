import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  allocateMoney,
  allocateWhole,
  ceilingRoom,
  grossReduction,
  LoyaltySettings,
  maxRedeemablePoints,
  Money,
  monthOf,
  pointsEarned,
  priceLine,
  returnEffect,
} from '@hotel/shared';
import Decimal from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { SYSTEM_SCOPE } from '../db/request-context';
import { conflict } from '../frontoffice/common';
import { OutboxService } from '../integration/outbox.service';
import { actorId, event, inclusiveTaxes } from '../pos/common';
import { LoyaltyLedgerService, MemberRow } from './ledger.service';
import { LoyaltyProgrammeService, ProgrammeVersion } from './programme.service';

interface CheckRow {
  id: string;
  propertyId: string;
  number: string;
  status: string;
  outletId: string;
  outletCode: string;
  businessDate: string;
  waiterId: string;
  openedBy: string | null;
  memberId: string | null;
  benefit: 'discount' | 'cashback' | null;
  stayId: string | null;
}

interface LineState {
  id: string;
  name: string;
  chargeCode: string;
  quantity: string;
  unitPrice: string;
  modifiersUnitPrice: string;
  rulePercent: string;
  ruleDiscount: string;
  discountPercent: string;
  isComp: boolean;
  isAlcohol: boolean;
  amount: string;
  memberDiscountPercent: string;
  memberDiscountAmount: string;
  rewardAmount: string;
  rewardPoints: number;
  rewardWallet: string;
  itemCode: string;
  categoryCode: string;
  gross: string;
}

/** A line priced for loyalty: eligibility and values before any reward. */
interface PricedLine extends LineState {
  /** Counts towards earning (LOY05, LOY12). */
  earns: boolean;
  /** Can carry a member discount or reward (adds LOY25 alcohol rule and stacking). */
  rewardable: boolean;
  excludedReason: string | null;
  /** Tax-inclusive amount after rule, manual and member discounts, before rewards. */
  beforeReward: string;
  /** Eligible value (net of tax by default) of beforeReward. */
  eligibleBefore: string;
}

export interface CheckTotals {
  total: string;
  paid: string;
  roomCharged: string;
  houseCharged: string;
}

const CHECK_SQL = `SELECT c.id, c.property_id AS "propertyId", c.number, c.status, c.outlet_id AS "outletId", o.code AS "outletCode",
  c.business_date AS "businessDate", c.waiter_id AS "waiterId", c.opened_by AS "openedBy", c.loyalty_member_id AS "memberId",
  c.loyalty_benefit AS benefit, c.stay_id AS "stayId"
  FROM pos_checks c JOIN outlets o ON o.id = c.outlet_id`;

function pct(v: string): Decimal {
  return new Decimal(v).dividedBy(100);
}

/**
 * Loyalty at the till and at checkout (LOY12, LOY13, CLUB02, LOY26, S01–S19):
 * attach a member, preview and apply rewards, commit them only with a settled
 * bill, award once per independently settled portion, and undo exactly what a
 * returned line used. The POS calls these inside its own transactions, after
 * locking the check, so a reward and the bill always change together.
 */
export interface SapMapping {
  id: string;
  cashbackExpense: string;
  walletLiability: string;
  reason: string;
  createdAt: string;
  createdBy: string | null;
}

@Injectable()
export class LoyaltyCheckoutService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LoyaltyLedgerService,
    private readonly programme: LoyaltyProgrammeService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  private async check(q: Queryable, propertyId: string, checkId: string, lock = false): Promise<CheckRow> {
    const { rows } = await q.query<CheckRow>(`${CHECK_SQL} WHERE c.property_id = $1 AND c.id = $2 ${lock ? 'FOR UPDATE OF c' : ''}`, [propertyId, checkId]);
    if (!rows[0]) throw new NotFoundException('Check not found at this property');
    return rows[0];
  }

  private async lines(q: Queryable, checkId: string): Promise<LineState[]> {
    const { rows } = await q.query<LineState>(
      `SELECT l.id, l.name, l.charge_code AS "chargeCode", l.quantity::text AS quantity, l.unit_price AS "unitPrice",
              l.modifiers_unit_price AS "modifiersUnitPrice", l.rule_percent::text AS "rulePercent", l.rule_discount AS "ruleDiscount",
              l.discount_percent::text AS "discountPercent", l.is_comp AS "isComp", l.is_alcohol AS "isAlcohol", l.amount,
              l.member_discount_percent::text AS "memberDiscountPercent", l.member_discount_amount AS "memberDiscountAmount",
              l.reward_amount AS "rewardAmount", l.reward_points AS "rewardPoints", l.reward_wallet AS "rewardWallet",
              mi.code AS "itemCode", mc.code AS "categoryCode",
              ((l.unit_price + l.modifiers_unit_price) * l.quantity)::numeric(18,2)::text AS gross
         FROM pos_check_lines l JOIN menu_items mi ON mi.id = l.item_id JOIN menu_categories mc ON mc.id = mi.category_id
        WHERE l.check_id = $1 AND l.status NOT IN ('cancelled', 'wasted') ORDER BY l.added_at, l.id`,
      [checkId],
    );
    return rows;
  }

  private excluded(l: LineState, outletCode: string, s: LoyaltySettings): string | null {
    const e = s.eligibility;
    if (e.participatingOutletCodes.length && !e.participatingOutletCodes.includes(outletCode)) return 'outlet not in the programme';
    if (l.isComp) return 'complimentary';
    if (e.excludedChargeCodes.includes(l.chargeCode)) return `charge ${l.chargeCode} excluded`;
    if (e.excludedCategoryCodes.includes(l.categoryCode)) return `category ${l.categoryCode} excluded`;
    if (e.excludedItemCodes.includes(l.itemCode)) return 'item excluded';
    return null;
  }

  /** Prices lines the way the bill will: rule and manual discounts, then the member discount. */
  private async price(q: Queryable, check: CheckRow, lines: LineState[], s: LoyaltySettings, memberDiscount: string | null): Promise<PricedLine[]> {
    const out: PricedLine[] = [];
    for (const l of lines) {
      const reason = this.excluded(l, check.outletCode, s);
      const promo = !new Decimal(l.rulePercent).isZero() || !new Decimal(l.discountPercent).isZero();
      const rewardable = reason === null && (s.eligibility.rewardsOnAlcohol || !l.isAlcohol);
      const base = priceLine({
        unitPrice: l.unitPrice, modifiersUnitPrice: l.modifiersUnitPrice, quantity: l.quantity, rulePercent: l.rulePercent, discountPercent: l.discountPercent,
      }).amount;
      // No overlapping benefits unless stacking is on (CLUB02): promotions and staff discounts keep their own price.
      const mdp = memberDiscount && rewardable && (s.stacking.enabled || !promo) ? memberDiscount : '0';
      const md = Money.of(new Decimal(base).times(pct(mdp)).toFixed(6));
      const beforeReward = Money.of(base).subtract(md).toString();
      const eligibleBefore = s.eligibility.basis === 'net' ? (await inclusiveTaxes(q, l.chargeCode, beforeReward)).net : beforeReward;
      out.push({
        ...l, memberDiscountPercent: mdp, memberDiscountAmount: md.toString(), earns: reason === null, rewardable,
        excludedReason: reason ?? (rewardable ? null : 'alcohol rewards are off (LOY25)'), beforeReward, eligibleBefore,
      });
    }
    return out;
  }

  private async writeLine(q: Queryable, l: PricedLine, reward: { amount: string; points: number; wallet: string }) {
    const amount = Money.of(l.beforeReward).subtract(reward.amount).toString();
    const tax = await inclusiveTaxes(q, l.chargeCode, amount);
    await q.query(
      `UPDATE pos_check_lines SET member_discount_percent = $2, member_discount_amount = $3, reward_amount = $4, reward_points = $5, reward_wallet = $6,
              amount = $7, net_amount = $8, tax_amount = $9, taxes = $10
        WHERE id = $1`,
      [l.id, l.memberDiscountPercent, l.memberDiscountAmount, reward.amount, reward.points, reward.wallet, tax.gross, tax.net, tax.tax, JSON.stringify(tax.lines)],
    );
  }

  /** The member's club discount that applies on this bill, if any. */
  private async memberDiscountFor(q: Queryable, check: CheckRow, s: LoyaltySettings): Promise<string | null> {
    if (!check.memberId) return null;
    const club = await this.programme.clubRates(q, check.memberId, `${check.businessDate}`, s);
    if (!club) return null;
    if (!s.stacking.enabled && check.benefit !== 'discount') return null;
    return new Decimal(club.discountPercent).isZero() ? null : club.discountPercent;
  }

  private async releaseReservations(q: Queryable, checkId: string, reason: string): Promise<number> {
    const { rowCount } = await q.query(
      `UPDATE loyalty_reservations SET status = 'released', resolved_at = now(), release_reason = $2 WHERE check_id = $1 AND status = 'active'`,
      [checkId, reason],
    );
    return rowCount ?? 0;
  }

  /**
   * Re-prices member discounts after the bill changed and drops any reward
   * held for it, so a changed bill never keeps a stale reward (S06). Called by
   * the POS after adding, discounting, cancelling, splitting or merging.
   */
  async refreshCheck(q: Queryable, propertyId: string, checkId: string): Promise<void> {
    const check = await this.check(q, propertyId, checkId);
    if (check.status !== 'open') return;
    const lines = await this.lines(q, checkId);
    const touched = lines.some((l) => !new Decimal(l.memberDiscountPercent).isZero() || !Money.of(l.rewardAmount).isZero());
    if (!check.memberId && !touched) return;
    const v = await this.programme.current(q);
    const priced = await this.price(q, check, lines, v.settings, await this.memberDiscountFor(q, check, v.settings));
    for (const l of priced) await this.writeLine(q, l, { amount: '0.00', points: 0, wallet: '0.00' });
    const released = await this.releaseReservations(q, checkId, 'The bill changed');
    if (released || lines.some((l) => !Money.of(l.rewardAmount).isZero())) await event(q, propertyId, checkId, 'rewards_released', { reason: 'bill changed' });
  }

  // -------------------------------------------------------------------------
  // Member on the bill (LOY11, CLUB02)
  // -------------------------------------------------------------------------

  async attach(q: Queryable, propertyId: string, checkId: string, memberId: string | null): Promise<void> {
    const check = await this.check(q, propertyId, checkId, true);
    if (check.status !== 'open') throw conflict(`Check ${check.number} is ${check.status}`, 'check_closed');
    const v = await this.programme.current(q);
    let benefit: 'discount' | 'cashback' | null = null;
    if (memberId) {
      const m = await this.ledger.member(q, memberId);
      if (m.status !== 'active') throw conflict(`Member ${m.number} is ${m.status}${m.mergedIntoId ? '; use the surviving member' : ''}`, 'member_inactive');
      const club = await this.programme.clubRates(q, memberId, check.businessDate, v.settings);
      benefit = club ? (v.settings.stacking.enabled ? 'discount' : v.settings.club.benefitWhenNotStacking) : null;
      await event(q, propertyId, checkId, 'member_attached', { member: m.number, club: club?.tierCode ?? null, benefit });
    } else if (check.memberId) {
      await event(q, propertyId, checkId, 'member_removed', null);
    }
    await q.query('UPDATE pos_checks SET loyalty_member_id = $2, loyalty_benefit = $3 WHERE id = $1', [checkId, memberId, benefit]);
    await this.releaseReservations(q, checkId, 'Member changed');
    await this.refreshCheck(q, propertyId, checkId);
  }

  /** With stacking off a club member gets the discount or the cashback on a bill, not both (CLUB02, CAT02). */
  async setBenefit(q: Queryable, propertyId: string, checkId: string, benefit: 'discount' | 'cashback'): Promise<void> {
    const check = await this.check(q, propertyId, checkId, true);
    if (check.status !== 'open') throw conflict(`Check ${check.number} is ${check.status}`, 'check_closed');
    if (!check.memberId) throw conflict('Attach a member first', 'no_member');
    const v = await this.programme.current(q);
    if (!(await this.programme.clubRates(q, check.memberId, check.businessDate, v.settings))) throw conflict('Only active club members choose a benefit', 'not_club');
    await q.query('UPDATE pos_checks SET loyalty_benefit = $2 WHERE id = $1', [checkId, benefit]);
    await event(q, propertyId, checkId, 'benefit_chosen', { benefit });
    await this.refreshCheck(q, propertyId, checkId);
  }

  // -------------------------------------------------------------------------
  // Checkout reward preview (LOY17) and redemption (LOY13, CLUB05, LOY26)
  // -------------------------------------------------------------------------

  private async monthBenefits(q: Queryable, memberId: string, month: string, excludeCheckId: string) {
    const { rows: [r] } = await q.query<{ before: string; given: string }>(
      `SELECT coalesce(sum((l.unit_price + l.modifiers_unit_price) * l.quantity), 0)::numeric(18,2)::text AS before,
              coalesce(sum(l.rule_discount + l.member_discount_amount + l.reward_amount), 0)::numeric(18,2)::text AS given
         FROM pos_checks c JOIN pos_check_lines l ON l.check_id = c.id AND l.status NOT IN ('cancelled', 'wasted')
        WHERE c.loyalty_member_id = $1 AND c.status = 'closed' AND date_trunc('month', c.business_date) = $2::date AND c.id <> $3`,
      [memberId, month, excludeCheckId],
    );
    return r;
  }

  async preview(q: Queryable, propertyId: string, checkId: string) {
    const check = await this.check(q, propertyId, checkId);
    const v = await this.programme.current(q);
    const s = v.settings;
    if (!check.memberId) return { member: null, settings: this.publicSettings(s) };
    await this.ledger.expireDue(q, check.memberId);
    const m = await this.ledger.member(q, check.memberId);
    const club = await this.programme.clubRates(q, check.memberId, check.businessDate, s);
    const lines = await this.lines(q, checkId);
    const priced = await this.price(q, check, lines, s, await this.memberDiscountFor(q, check, s));
    const balances = await this.ledger.balances(q, check.memberId, checkId);
    const rewardable = priced.filter((l) => l.rewardable);
    const eligibleForRewards = Money.sum(rewardable.map((l) => Money.of(l.eligibleBefore))).toString();
    const memberDiscount = Money.sum(priced.map((l) => Money.of(l.memberDiscountAmount))).toString();
    const blocked: string[] = [];
    const pointsAvailable = Number(balances.points.available);
    const walletAvailable = balances.wallet.available;
    if (Number(balances.points.deficit) > 0) blocked.push('Points balance is negative; redemption is blocked until new earning covers it (S17)');
    const discounted = !Money.of(memberDiscount).isZero();
    if (!s.stacking.enabled && discounted) blocked.push('Stacking is off and this bill has the club discount: choose cashback to use points or credit instead');
    let maxPoints = maxRedeemablePoints({
      eligible: eligibleForRewards, capPercent: s.points.redeemCapPercent, pointValue: s.points.pointValue, available: Math.max(0, pointsAvailable), minRedeem: s.points.minRedeemPoints,
    });
    let maxWallet = Decimal.max(0, Decimal.min(walletAvailable, new Decimal(eligibleForRewards).times(pct(s.club.walletCapPercent)))).toFixed(2);
    if (blocked.length) {
      maxPoints = 0;
      maxWallet = '0.00';
    }
    if (new Decimal(balances.wallet.deficit).gt(0)) maxWallet = '0.00';
    // LOY26: with stacking on, benefits stop at the ceiling for the bill and for the member's month.
    let ceiling: null | { percent: string; billRoom: string; monthRoom: string } = null;
    if (s.stacking.enabled) {
      const before = Money.sum(priced.map((l) => Money.of(l.gross))).toString();
      const given = Money.sum(priced.map((l) => Money.of(l.ruleDiscount).add(l.memberDiscountAmount))).toString();
      const month = await this.monthBenefits(q, check.memberId, monthOf(check.businessDate), checkId);
      ceiling = {
        percent: s.stacking.ceilingPercent,
        billRoom: ceilingRoom(before, s.stacking.ceilingPercent, given),
        monthRoom: ceilingRoom(Money.of(month.before).add(before).toString(), s.stacking.ceilingPercent, Money.of(month.given).add(given).toString()),
      };
    }
    const held = await q.query<{ unit: string; amount: string; expiresAt: string; expired: boolean }>(
      `SELECT unit, amount::text, expires_at AS "expiresAt", expires_at <= now() AS expired FROM loyalty_reservations WHERE check_id = $1 AND status = 'active'`,
      [checkId],
    );
    const appliedPoints = lines.reduce((a, l) => a + l.rewardPoints, 0);
    const appliedWallet = Money.sum(lines.map((l) => Money.of(l.rewardWallet))).toString();
    const eligibleAfter = Money.sum(priced.filter((l) => l.earns).map((l) => Money.of(l.eligibleBefore))).subtract(new Decimal(appliedPoints).times(s.points.pointValue).toFixed(2)).subtract(appliedWallet);
    const earnsCashback = !!club && !s.club.earnsPoints && (s.stacking.enabled || check.benefit === 'cashback');
    const earnsPoints = !club || s.club.earnsPoints;
    const staffOwn = this.staffOwnBill(m, check);
    return {
      member: { id: m.id, number: m.number, name: m.displayName.split(' ')[0], staffFlagged: m.staffFlagged },
      club: club ? { tier: club.tierCode, discountPercent: club.discountPercent, cashbackPercent: club.cashbackPercent, benefit: check.benefit } : null,
      settings: this.publicSettings(s),
      programmeVersion: v.version,
      balances,
      eligible: {
        beforeRewards: Money.sum(priced.filter((l) => l.earns).map((l) => Money.of(l.eligibleBefore))).toString(),
        forRewards: eligibleForRewards,
        afterRewards: eligibleAfter.toString(),
        basis: s.eligibility.basis,
      },
      memberDiscount,
      redeem: { maxPoints, maxPointsValue: new Decimal(maxPoints).times(s.points.pointValue).toFixed(2), maxWallet, blocked, ceiling },
      applied: { points: appliedPoints, wallet: appliedWallet, rewardAmount: Money.sum(lines.map((l) => Money.of(l.rewardAmount))).toString(), holds: held.rows },
      earnPreview: staffOwn
        ? { points: 0, cashback: '0.00', note: 'Staff member on their own bill: no earning (LOY22)' }
        : {
            points: earnsPoints && !earnsCashback ? pointsEarned(eligibleAfter.toString(), s.points.earnUnit) : 0,
            cashback: earnsCashback ? Money.of(Decimal.max(0, eligibleAfter.toString()).toFixed(2)).multiply(club!.cashbackPercent).divide(100).toString() : '0.00',
            note: club && !earnsCashback && !s.club.earnsPoints ? 'Club discount on this bill instead of cashback' : null,
          },
      lines: priced.map((l) => ({
        id: l.id, name: l.name, amount: l.amount, eligibleBefore: l.eligibleBefore, earns: l.earns, rewardable: l.rewardable, excludedReason: l.excludedReason,
        memberDiscount: l.memberDiscountAmount, rewardPoints: l.rewardPoints, rewardWallet: l.rewardWallet,
      })),
    };
  }

  private publicSettings(s: LoyaltySettings) {
    return {
      earnUnit: s.points.earnUnit, pointValue: s.points.pointValue, redeemCapPercent: s.points.redeemCapPercent, minRedeemPoints: s.points.minRedeemPoints,
      stacking: s.stacking.enabled, ceilingPercent: s.stacking.ceilingPercent, basis: s.eligibility.basis, otpDelivery: s.verification.otpDelivery,
      walletCapPercent: s.club.walletCapPercent,
    };
  }

  private staffOwnBill(m: MemberRow, check: CheckRow): boolean {
    if (!m.staffFlagged || !m.staffUserId) return false;
    return [check.waiterId, check.openedBy, actorId()].includes(m.staffUserId);
  }

  /**
   * Holds points and/or wallet credit for this bill and shows them on it
   * (LOY13): the member must be verified by OTP or card QR, the balance is
   * checked under the member lock so two tills cannot spend it twice (S20),
   * and the hold commits only when the bill settles.
   */
  async applyRewards(q: Queryable, propertyId: string, checkId: string, input: { points?: number; wallet?: string; verificationId: string }) {
    const check = await this.check(q, propertyId, checkId, true);
    if (check.status !== 'open') throw conflict(`Check ${check.number} is ${check.status}`, 'check_closed');
    if (!check.memberId) throw conflict('Attach a member to the bill first', 'no_member');
    const points = input.points ?? 0;
    const wallet = Money.of(input.wallet ?? '0');
    if (points < 0 || wallet.isNegative() || (points === 0 && wallet.isZero())) throw new BadRequestException('Choose points or wallet credit to use');
    const { rows: [ver] } = await q.query<{ ok: boolean }>(
      `SELECT verified_at IS NOT NULL AND verified_at > now() - interval '15 minutes' AND (check_id IS NULL OR check_id = $3) AS ok
         FROM loyalty_verifications WHERE id = $1 AND member_id = $2 AND purpose = 'redeem'`,
      [input.verificationId, check.memberId, checkId],
    );
    if (!ver?.ok) throw conflict('Verify the member with the OTP or the member card before redeeming (LOY22)', 'verification_required');
    await this.ledger.lockMember(q, check.memberId);
    // Drop any earlier hold on this bill, then price afresh.
    await this.releaseReservations(q, checkId, 'Replaced');
    await this.refreshCheck(q, propertyId, checkId);
    const p = await this.preview(q, propertyId, checkId);
    if (!p.member) throw conflict('Attach a member to the bill first', 'no_member');
    if (p.redeem.blocked.length) throw conflict(p.redeem.blocked[0], 'redemption_blocked');
    const s = (await this.programme.current(q)).settings;
    if (!s.stacking.enabled && points > 0 && !wallet.isZero()) throw conflict('Stacking is off: use points or wallet credit on a bill, not both', 'stacking_off');
    if (points > p.redeem.maxPoints) {
      throw conflict(
        p.redeem.maxPoints ? `At most ${p.redeem.maxPoints} points can be used on this bill` : `Points cannot be used on this bill (minimum ${s.points.minRedeemPoints}, cap ${s.points.redeemCapPercent}% of eligible spend)`,
        'redeem_limit', { maxPoints: p.redeem.maxPoints },
      );
    }
    if (wallet.compare(p.redeem.maxWallet) > 0) throw conflict(`At most KES ${Money.of(p.redeem.maxWallet).format().replace('KES ', '')} of wallet credit can be used on this bill`, 'redeem_limit', { maxWallet: p.redeem.maxWallet });

    // Allocate to rewardable lines by their eligible value (LOY12), points as whole numbers.
    const check2 = await this.check(q, propertyId, checkId);
    const priced = (await this.price(q, check2, await this.lines(q, checkId), s, await this.memberDiscountFor(q, check2, s)));
    const weights = priced.map((l) => (l.rewardable ? l.eligibleBefore : '0'));
    const pts = allocateWhole(points, weights);
    const wal = allocateMoney(wallet.toString(), weights);
    let totalReduction = Money.zero();
    const plan = priced.map((l, i) => {
      const value = new Decimal(pts[i]).times(s.points.pointValue).plus(wal[i]).toFixed(2);
      const amount = grossReduction(value, l.beforeReward, l.eligibleBefore, s.eligibility.basis);
      totalReduction = totalReduction.add(amount);
      return { line: l, points: pts[i], wallet: wal[i], amount };
    });
    if (p.redeem.ceiling) {
      const room = Money.of(p.redeem.ceiling.billRoom).compare(p.redeem.ceiling.monthRoom) < 0 ? p.redeem.ceiling.billRoom : p.redeem.ceiling.monthRoom;
      if (totalReduction.compare(room) > 0) {
        throw conflict(`That would take benefits on this bill past the ${s.stacking.ceilingPercent}% ceiling; KES ${room} is left (LOY26)`, 'benefit_ceiling', { room });
      }
    }
    for (const x of plan) await this.writeLine(q, x.line, { amount: x.amount, points: x.points, wallet: x.wallet });
    const expires = `now() + make_interval(mins => ${s.reservationMinutes})`;
    for (const [unit, amount] of [['points', String(points)], ['wallet', wallet.toString()]] as const) {
      if (new Decimal(amount).isZero()) continue;
      await q.query(
        `INSERT INTO loyalty_reservations (member_id, unit, amount, check_id, property_id, verification_id, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, ${expires}, $7)`,
        [check.memberId, unit, amount, checkId, propertyId, input.verificationId, actorId()],
      );
    }
    await event(q, propertyId, checkId, 'rewards_applied', { points, wallet: wallet.toString(), billReduction: totalReduction.toString() });
  }

  async removeRewards(q: Queryable, propertyId: string, checkId: string): Promise<void> {
    const check = await this.check(q, propertyId, checkId, true);
    if (check.status !== 'open') throw conflict(`Check ${check.number} is ${check.status}`, 'check_closed');
    await this.releaseReservations(q, checkId, 'Removed at the till');
    await this.refreshCheck(q, propertyId, checkId);
  }

  /** Drops any reward held for a bill that was voided or merged away. */
  async releaseHolds(q: Queryable, checkId: string, reason: string): Promise<void> {
    await this.releaseReservations(q, checkId, reason);
  }

  /** Keeps a hold alive while checkout is active (LOY13 "extend only while checkout remains active"). */
  async touch(q: Queryable, checkId: string): Promise<void> {
    await q.query(
      `UPDATE loyalty_reservations r SET expires_at = now() + make_interval(mins => coalesce((v.settings ->> 'reservationMinutes')::int, 15))
         FROM (SELECT settings FROM loyalty_programme_versions WHERE effective_from <= now() ORDER BY effective_from DESC, version DESC LIMIT 1) v
        WHERE r.check_id = $1 AND r.status = 'active' AND r.expires_at > now()`,
      [checkId],
    );
  }

  /**
   * Holds that timed out on bills still open go back to the member, and the
   * bill is re-priced without them (S24). Run by the maintenance job.
   */
  async releaseExpiredHolds(): Promise<number> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ checkId: string; propertyId: string }>(
        `SELECT DISTINCT r.check_id AS "checkId", r.property_id AS "propertyId" FROM loyalty_reservations r JOIN pos_checks c ON c.id = r.check_id
          WHERE r.status = 'active' AND r.expires_at <= now() AND c.status = 'open'`,
      );
      for (const r of rows) {
        await q.query('SELECT 1 FROM pos_checks WHERE id = $1 FOR UPDATE', [r.checkId]);
        await this.releaseReservations(q, r.checkId, 'Timed out');
        await this.refreshCheck(q, r.propertyId, r.checkId);
      }
      // Holds on bills that closed or were voided without committing them.
      await q.query(
        `UPDATE loyalty_reservations r SET status = 'released', resolved_at = now(), release_reason = 'Bill ' || c.status
           FROM pos_checks c WHERE c.id = r.check_id AND r.status = 'active' AND c.status <> 'open'`,
      );
      return rows.length;
    }, SYSTEM_SCOPE);
  }

  // -------------------------------------------------------------------------
  // Settlement: commit rewards and award once (S01, S03, S07, LOY12, LOY22)
  // -------------------------------------------------------------------------

  /**
   * Called by the POS as a check closes, in the same transaction. Commits the
   * held rewards, awards points or cashback on the paid share now and keeps
   * the room-charged share pending until checkout settles the folio.
   */
  async onCheckClosed(q: Queryable, propertyId: string, checkId: string, totals: CheckTotals, settlement: string): Promise<void> {
    const check = await this.check(q, propertyId, checkId);
    if (!check.memberId) {
      await this.releaseReservations(q, checkId, 'No member');
      return;
    }
    const member = await this.ledger.lockMember(q, check.memberId);
    const v = await this.programme.current(q);
    const s = v.settings;
    const lines = await this.lines(q, checkId);
    const ctx = { propertyId, outletId: check.outletId, businessDate: check.businessDate, checkId, programmeVersionId: v.id };

    // 1. Commit held rewards. A hold that timed out still commits if the balance is there.
    const { rows: holds } = await q.query<{ id: string; unit: 'points' | 'wallet'; amount: string }>(
      `SELECT id, unit, amount::text FROM loyalty_reservations WHERE check_id = $1 AND status = 'active' FOR UPDATE`,
      [checkId],
    );
    const usedPoints = lines.reduce((a, l) => a + l.rewardPoints, 0);
    const usedWallet = Money.sum(lines.map((l) => Money.of(l.rewardWallet)));
    if (settlement === 'house_account' || settlement === 'zero') {
      if (usedPoints || !usedWallet.isZero()) throw conflict('Remove the loyalty reward before sending this bill to a house account', 'reward_on_house_account');
    }
    for (const [unit, used] of [['points', new Decimal(usedPoints)], ['wallet', new Decimal(usedWallet.toString())]] as const) {
      if (used.isZero()) continue;
      const hold = holds.find((h) => h.unit === unit);
      if (!hold || !new Decimal(hold.amount).equals(used)) throw conflict('The loyalty reward on this bill is no longer held; remove it and apply it again', 'reward_expired');
      const value = unit === 'points' ? used.times(s.points.pointValue).toFixed(2) : used.toFixed(2);
      const posted = await this.ledger.post(q, {
        ...ctx, key: `redeem:${checkId}:${unit}`, memberId: member.id, unit, type: 'redeem', amount: used.negated().toFixed(2), value: new Decimal(value).negated().toFixed(2),
        details: { check: check.number },
      }).catch((e) => {
        if (e?.response?.error === 'insufficient_balance') throw conflict('The member no longer has enough balance for this reward; remove it and try again', 'reward_expired');
        throw e;
      });
      await q.query(`UPDATE loyalty_reservations SET status = 'committed', resolved_at = now(), event_id = $2 WHERE id = $1`, [hold.id, posted.eventId]);
    }
    await this.releaseReservations(q, checkId, 'Not used');

    // 2. Eligible value after rewards, split into the paid share and the room-charged share (S07).
    const priced = await this.price(q, check, lines.map((l) => ({ ...l, amount: Money.of(l.amount).add(l.rewardAmount).toString() })), s, null);
    // price() recomputes from the snapshot; keep the member discount actually on the line.
    const elig = priced.map((p, i) => {
      const l = lines[i];
      const beforeReward = Money.of(l.amount).add(l.rewardAmount).toString();
      return { ...p, beforeReward, memberDiscountAmount: l.memberDiscountAmount };
    });
    for (const e of elig) {
      e.eligibleBefore = s.eligibility.basis === 'net' ? (await inclusiveTaxes(q, e.chargeCode, e.beforeReward)).net : e.beforeReward;
    }
    const after = elig.map((e, i) => (e.earns ? Decimal.max(0, new Decimal(e.eligibleBefore).minus(new Decimal(lines[i].rewardPoints).times(s.points.pointValue)).minus(lines[i].rewardWallet)).toFixed(2) : '0.00'));
    const total = new Decimal(totals.total);
    const paidRatio = total.isZero() ? new Decimal(0) : new Decimal(totals.paid).dividedBy(total);
    const roomRatio = total.isZero() ? new Decimal(0) : new Decimal(totals.roomCharged).dividedBy(total);
    const afterTotal = Money.sum(after.map((a) => Money.of(a)));
    const paidEligible = settlement === 'house_account' ? Money.zero() : Money.of(afterTotal.multiply(paidRatio.toFixed(12)).toString());
    const pendingEligible = settlement === 'house_account' ? Money.zero() : Money.of(afterTotal.multiply(roomRatio.toFixed(12)).toString());
    const paidShares = allocateMoney(paidEligible.toString(), after);
    const pendingShares = allocateMoney(pendingEligible.toString(), after);

    const club = await this.programme.clubRates(q, member.id, check.businessDate, s);
    const cashback = !!club && !s.club.earnsPoints && (s.stacking.enabled || check.benefit === 'cashback');
    const earnPointsHere = !club || s.club.earnsPoints;
    const staffOwn = this.staffOwnBill(member, check) && !s.misuse.staffEarnsOnOwnBills;
    const note = staffOwn ? 'Staff member on their own bill: no earning (LOY22)' : club && !cashback && !earnPointsHere ? 'Club discount instead of cashback' : null;

    for (const [i, e] of elig.entries()) {
      await q.query(
        `INSERT INTO loyalty_check_allocations (check_id, line_id, member_id, property_id, programme_version_id, eligible, excluded_reason, eligible_before,
                                                points, wallet, paid_share, pending_share, cashback_percent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (check_id, line_id) DO NOTHING`,
        [checkId, e.id, member.id, propertyId, v.id, e.earns, e.excludedReason, e.earns ? e.eligibleBefore : '0.00', lines[i].rewardPoints, lines[i].rewardWallet,
         paidShares[i], pendingShares[i], cashback ? club!.cashbackPercent : null],
      );
    }

    // 3. Award on the paid share now: one earning event per check, rounded once (S01).
    let earned = 0;
    let cashbackPending = Money.zero();
    if (!staffOwn && paidEligible.compare(0) > 0) {
      if (cashback) {
        await this.accrue(q, {
          key: `cb:check:${checkId}`, memberId: member.id, propertyId, outletId: check.outletId, checkId, saleDate: check.businessDate,
          month: monthOf(check.businessDate), eligible: paidEligible.toString(), rate: club!.cashbackPercent, rateSource: club!.source.cashback,
        });
        cashbackPending = paidEligible.multiply(club!.cashbackPercent).divide(100);
      } else if (earnPointsHere) {
        earned = await this.earnPoints(q, member.id, s, paidEligible.toString(), check.businessDate, { ...ctx, key: `earn:check:${checkId}`, details: { check: check.number } });
      }
    }
    // 4. Room-charged share waits for the folio to be settled (S03).
    let pendingPoints = 0;
    if (!staffOwn && pendingEligible.compare(0) > 0 && (cashback || earnPointsHere)) {
      await q.query(
        `INSERT INTO loyalty_pending (member_id, property_id, outlet_id, check_id, stay_id, source, eligible_amount, cashback_percent, sale_date, programme_version_id)
         VALUES ($1, $2, $3, $4, $5, 'room_charge', $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [member.id, propertyId, check.outletId, checkId, check.stayId, pendingEligible.toString(), cashback ? club!.cashbackPercent : null, check.businessDate, v.id],
      );
      pendingPoints = cashback ? 0 : pointsEarned(pendingEligible.toString(), s.points.earnUnit);
      if (cashback) cashbackPending = cashbackPending.add(pendingEligible.multiply(club!.cashbackPercent).divide(100));
    }

    // 5. Wallet used on a bill releases the cashback liability in SAP (CLUB07).
    if (!usedWallet.isZero()) await this.journal(q, s, { propertyId, ref: `${check.number}-WLT`, kind: 'WALLET_REDEMPTION', amount: usedWallet.toString(), date: check.businessDate, memo: `Wallet credit used on ${check.number} by ${member.number}`, reverse: true });

    const bal = await this.ledger.balances(q, member.id);
    await q.query(
      `INSERT INTO loyalty_check_outcomes (check_id, member_id, points_earned, points_pending, points_redeemed, wallet_redeemed, member_discount, cashback_pending,
                                           closing_points, closing_wallet, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
      [checkId, member.id, earned, pendingPoints, usedPoints, usedWallet.toString(), Money.sum(lines.map((l) => Money.of(l.memberDiscountAmount))).toString(),
       Money.of(cashbackPending.toString()).toString(), Number(bal.points.available), bal.wallet.available, note],
    );
    await event(q, propertyId, checkId, 'loyalty_settled', { member: member.number, earned, pendingPoints, redeemed: usedPoints, wallet: usedWallet.toString(), note });
  }

  /** One earning event, after the daily earning cap (LOY22). Returns the points awarded. */
  private async earnPoints(q: Queryable, memberId: string, s: LoyaltySettings, eligible: string, businessDate: string, p: { key: string } & Record<string, unknown>): Promise<number> {
    let points = pointsEarned(eligible, s.points.earnUnit);
    let capped = false;
    if (s.points.dailyEarnCap !== null && points > 0) {
      const { rows: [d] } = await q.query<{ n: string }>(
        `SELECT coalesce(sum(amount), 0)::text AS n FROM loyalty_events WHERE member_id = $1 AND unit = 'points' AND type = 'earn' AND business_date = $2 AND event_key <> $3`,
        [memberId, businessDate, p.key],
      );
      const room = Math.max(0, s.points.dailyEarnCap - Number(d.n));
      if (points > room) {
        points = room;
        capped = true;
      }
    }
    if (points <= 0) return 0;
    await this.ledger.post(q, {
      ...(p as object), key: p.key, memberId, unit: 'points', type: 'earn', amount: String(points), value: new Decimal(points).times(s.points.pointValue).toFixed(2),
      businessDate, expiresAt: this.ledger.expiry(s.points.expiryMonths), lotKind: 'earned',
      details: { ...((p.details as object) ?? {}), eligible, ...(capped ? { cappedBy: 'daily earning cap' } : {}) },
    });
    return points;
  }

  private async accrue(q: Queryable, a: {
    key: string; memberId: string; propertyId: string; outletId?: string | null; checkId?: string | null; folioId?: string | null; returnId?: string | null;
    kind?: 'sale' | 'return'; saleDate: string; month: string; eligible: string; rate: string; rateSource: string; originalId?: string | null;
  }) {
    await q.query(
      `INSERT INTO cashback_accruals (accrual_key, member_id, property_id, outlet_id, check_id, folio_id, return_id, kind, sale_date, settlement_month,
                                      eligible_amount, rate_percent, rate_source, original_accrual_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (accrual_key) DO NOTHING`,
      [a.key, a.memberId, a.propertyId, a.outletId ?? null, a.checkId ?? null, a.folioId ?? null, a.returnId ?? null, a.kind ?? 'sale', a.saleDate, a.month,
       a.eligible, a.rate, a.rateSource, a.originalId ?? null],
    );
  }

  /**
   * Loyalty journal to SAP (LOY18, CLUB07) with the G/L accounts finance mapped.
   * Until they are mapped the journal is held, and it goes to SAP once when
   * the mapping is saved (`mapSapAccounts`).
   */
  async journal(q: Queryable, _s: LoyaltySettings, j: { propertyId: string; ref: string; kind: string; amount: string; date: string; memo: string; reverse?: boolean }) {
    const amount = Money.of(j.amount).toString();
    const mapping = await this.sapMapping(q);
    if (!mapping) {
      await q.query(
        `INSERT INTO loyalty_held_journals (property_id, external_ref, kind, doc_date, memo, amount, reverse)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (external_ref) DO NOTHING`,
        [j.propertyId, j.ref, j.kind, j.date, j.memo, amount, !!j.reverse],
      );
      return;
    }
    await this.enqueueJournal(q, mapping, { ...j, amount });
  }

  private async enqueueJournal(q: Queryable, m: SapMapping, j: { propertyId: string; ref: string; kind: string; amount: string; date: string; memo: string; reverse?: boolean }) {
    const lines = j.reverse
      ? [{ account: m.walletLiability, debit: j.amount, credit: '0.00' }, { account: m.cashbackExpense, debit: '0.00', credit: j.amount }]
      : [{ account: m.cashbackExpense, debit: j.amount, credit: '0.00' }, { account: m.walletLiability, debit: '0.00', credit: j.amount }];
    const { rowCount } = await q.query('SELECT 1 FROM integration_outbox WHERE external_ref = $1', [j.ref]);
    if (rowCount) return;
    await this.outbox.enqueue({ propertyId: j.propertyId, eventType: 'LOYALTY_JOURNAL', externalRef: j.ref, payload: { kind: j.kind, docDate: j.date, memo: j.memo, lines } });
  }

  /** The G/L accounts in force, or null while finance has not mapped them. */
  async sapMapping(q: Queryable): Promise<SapMapping | null> {
    const { rows } = await q.query<SapMapping>(
      `SELECT a.id, a.cashback_expense AS "cashbackExpense", a.wallet_liability AS "walletLiability", a.reason, a.created_at AS "createdAt", u.display_name AS "createdBy"
         FROM loyalty_sap_accounts a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /** The mapping in force and the journals still waiting for it. */
  async sapAccounts() {
    return this.db.tx(async (q) => {
      const { rows: [held] } = await q.query<{ count: number; amount: string }>(
        `SELECT count(*)::int AS count, coalesce(sum(amount), 0)::numeric(18,2)::text AS amount FROM loyalty_held_journals WHERE released_at IS NULL`,
      );
      const { rows: history } = await q.query(
        `SELECT a.cashback_expense AS "cashbackExpense", a.wallet_liability AS "walletLiability", a.reason, a.created_at AS "createdAt", u.display_name AS "createdBy"
           FROM loyalty_sap_accounts a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC LIMIT 20`,
      );
      return { current: await this.sapMapping(q), held, history };
    });
  }

  /** Saves the mapping (finance) and sends every held journal to SAP once with it. */
  async mapSapAccounts(input: { cashbackExpense: string; walletLiability: string; reason: string }) {
    return this.db.tx(async (q) => {
      const { rows: [m] } = await q.query<{ id: string }>(
        `INSERT INTO loyalty_sap_accounts (cashback_expense, wallet_liability, reason, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.cashbackExpense, input.walletLiability, input.reason, actorId()],
      );
      const mapping = (await this.sapMapping(q))!;
      const { rows: held } = await q.query<{ id: string; propertyId: string; ref: string; kind: string; date: string; memo: string; amount: string; reverse: boolean }>(
        `SELECT id, property_id AS "propertyId", external_ref AS ref, kind, doc_date::text AS date, memo, amount::text, reverse
           FROM loyalty_held_journals WHERE released_at IS NULL ORDER BY created_at FOR UPDATE`,
      );
      for (const h of held) {
        await this.enqueueJournal(q, mapping, h);
        await q.query('UPDATE loyalty_held_journals SET released_at = now(), mapping_id = $2 WHERE id = $1', [h.id, m.id]);
      }
      await this.audit.record({
        action: 'loyalty.sap_accounts', entityType: 'loyalty_sap_accounts', entityId: m.id, reason: input.reason,
        newValues: { cashbackExpense: input.cashbackExpense, walletLiability: input.walletLiability, released: held.length },
      });
      return { ...(await this.sapAccounts()), released: held.length };
    });
  }

  // -------------------------------------------------------------------------
  // Hotel settlement (S03, S05, LOY27, LAT03, LAT08)
  // -------------------------------------------------------------------------

  /**
   * Called by checkout once the folio is settled. Room-charged POS shares and
   * the stay's own eligible charges earn now, once; a company (city ledger)
   * bill keeps them pending until finance confirms the company paid.
   */
  async onFolioSettled(q: Queryable, f: { propertyId: string; folioId: string; stayId: string; cityLedger: boolean; businessDate: string }): Promise<void> {
    const v = await this.programme.current(q);
    const s = v.settings;
    // The stay guest's own charges: rooms only for direct or corporate bookings and eligible rates.
    const { rows: [stay] } = await q.query<{ memberId: string | null; source: string; companyId: string | null; ratePlan: string; arrival: string }>(
      `SELECT (SELECT m.id FROM loyalty_members m WHERE m.guest_id = s.primary_guest_id AND m.status = 'active') AS "memberId",
              r.source::text AS source, r.company_id AS "companyId", rp.code AS "ratePlan", s.arrival_date AS arrival
         FROM stays s JOIN reservations r ON r.id = s.reservation_id JOIN rate_plans rp ON rp.id = s.rate_plan_id WHERE s.id = $1`,
      [f.stayId],
    );
    if (stay?.memberId) {
      const roomsEarn = (s.rooms.earningSources.includes(stay.source) || (s.rooms.corporateEarns && !!stay.companyId)) && !s.rooms.excludedRatePlanCodes.includes(stay.ratePlan);
      const { rows: [sum] } = await q.query<{ eligible: string }>(
        `SELECT coalesce(sum(CASE WHEN $3 = 'net' THEN fc.net_amount ELSE fc.amount END), 0)::numeric(18,2)::text AS eligible
           FROM folio_charges fc JOIN charge_codes cc ON cc.code = fc.charge_code
          WHERE fc.folio_id = $1 AND fc.pos_check_id IS NULL AND NOT (fc.charge_code = ANY($2::text[]))
            AND (cc.category <> 'accommodation' OR $4)`,
        [f.folioId, s.eligibility.excludedChargeCodes, s.eligibility.basis, roomsEarn],
      );
      const m = await this.ledger.member(q, stay.memberId);
      const club = await this.programme.clubRates(q, m.id, f.businessDate, s);
      const cashback = !!club && !s.club.earnsPoints;
      if (Money.of(sum.eligible).compare(0) > 0) {
        await q.query(
          `INSERT INTO loyalty_pending (member_id, property_id, folio_id, stay_id, source, eligible_amount, cashback_percent, sale_date, programme_version_id)
           VALUES ($1, $2, $3, $4, 'stay', $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [m.id, f.propertyId, f.folioId, f.stayId, sum.eligible, cashback ? club!.cashbackPercent : null, f.businessDate, v.id],
        );
      }
    }
    // Every pending share linked to this folio: the stay's own and its room-charged POS bills.
    const { rows: pend } = await q.query<{ id: string }>(
      `SELECT lp.id FROM loyalty_pending lp
        WHERE lp.status = 'pending' AND (lp.folio_id = $1 OR lp.check_id IN (SELECT DISTINCT pos_check_id FROM folio_charges WHERE folio_id = $1 AND pos_check_id IS NOT NULL))
        FOR UPDATE`,
      [f.folioId],
    );
    for (const p of pend) {
      if (f.cityLedger) {
        await q.query(`UPDATE loyalty_pending SET status = 'awaiting_company_payment', folio_id = coalesce(folio_id, $2) WHERE id = $1`, [p.id, f.folioId]);
      } else {
        await this.release(q, p.id, f.businessDate, 'Folio settled at checkout');
      }
    }
  }

  /** Turns one pending share into points or a cashback accrual, once (S05). */
  async release(q: Queryable, pendingId: string, businessDate: string, note: string): Promise<void> {
    const { rows: [p] } = await q.query<{
      id: string; memberId: string; propertyId: string; outletId: string | null; checkId: string | null; folioId: string | null; stayId: string | null;
      eligible: string; cashback: string | null; saleDate: string; versionId: string; status: string;
    }>(
      `SELECT id, member_id AS "memberId", property_id AS "propertyId", outlet_id AS "outletId", check_id AS "checkId", folio_id AS "folioId", stay_id AS "stayId",
              eligible_amount::text AS eligible, cashback_percent::text AS cashback, sale_date AS "saleDate", programme_version_id AS "versionId", status
         FROM loyalty_pending WHERE id = $1 FOR UPDATE`,
      [pendingId],
    );
    if (!p || ['released', 'cancelled'].includes(p.status)) return;
    await this.ledger.lockMember(q, p.memberId);
    const v = await this.programme.byId(q, p.versionId); // the rules of the sale, not today's
    let eventId: string | null = null;
    if (p.cashback !== null) {
      await this.accrue(q, {
        key: `cb:pending:${p.id}`, memberId: p.memberId, propertyId: p.propertyId, outletId: p.outletId, checkId: p.checkId, folioId: p.folioId,
        saleDate: p.saleDate, month: monthOf(businessDate), eligible: p.eligible, rate: p.cashback, rateSource: 'sale',
      });
    } else {
      const key = `earn:pending:${p.id}`;
      const points = await this.earnPoints(q, p.memberId, v.settings, p.eligible, businessDate, {
        key, propertyId: p.propertyId, outletId: p.outletId, checkId: p.checkId, folioId: p.folioId, stayId: p.stayId, programmeVersionId: v.id,
        details: { pending: p.id, saleDate: p.saleDate },
      });
      if (points) eventId = (await q.query<{ id: string }>('SELECT id::text FROM loyalty_events WHERE event_key = $1', [key])).rows[0]?.id ?? null;
    }
    await q.query(
      `UPDATE loyalty_pending SET status = 'released', released_event_id = $2, resolution_note = $3, resolved_at = now(), resolved_by = $4 WHERE id = $1`,
      [p.id, eventId, note, actorId()],
    );
  }

  /** Finance confirms a company paid its bill: pending points for that folio are released once (LAT08). */
  async confirmCompanyPayment(propertyId: string, folioId: string, reason: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM loyalty_pending WHERE folio_id = $1 AND property_id = $2 AND status = 'awaiting_company_payment' FOR UPDATE`,
        [folioId, propertyId],
      );
      const { rows: [bd] } = await q.query<{ d: string }>('SELECT current_business_date::text AS d FROM properties WHERE id = $1', [propertyId]);
      for (const r of rows) await this.release(q, r.id, bd.d, `Company payment confirmed: ${reason}`);
      await this.audit.record({ action: 'loyalty.company_payment_confirmed', entityType: 'folio', entityId: folioId, propertyId, reason, newValues: { released: rows.length } });
      return { released: rows.length };
    });
  }

  // -------------------------------------------------------------------------
  // Returns (S15, S16, S17, CAT07, CAT08, LAT05)
  // -------------------------------------------------------------------------

  /**
   * Undoes what returned lines carried, under the sale's own rules: restores
   * their allocated points and credit (original expiry, or grace if expired),
   * recomputes earning on what is kept and reverses only the difference,
   * letting the balance go negative if the points were already spent.
   */
  async onReturn(q: Queryable, r: { propertyId: string; checkId: string; returnId: string; businessDate: string; lines: Array<{ lineId: string; returned: string; kept: string }> }) {
    const { rows: [c] } = await q.query<{ memberId: string | null; outletId: string; number: string }>(
      'SELECT loyalty_member_id AS "memberId", outlet_id AS "outletId", number FROM pos_checks WHERE id = $1',
      [r.checkId],
    );
    const none = { pointsRestored: 0, pointsReversed: 0, walletRestored: '0.00' };
    if (!c?.memberId) return none;
    const { rows: allocs } = await q.query<{ lineId: string; eligible: boolean; eligibleBefore: string; points: number; wallet: string; paidShare: string; versionId: string; cashback: string | null }>(
      `SELECT line_id AS "lineId", eligible, eligible_before::text AS "eligibleBefore", points, wallet::text, paid_share::text AS "paidShare",
              programme_version_id AS "versionId", cashback_percent::text AS cashback
         FROM loyalty_check_allocations WHERE check_id = $1`,
      [r.checkId],
    );
    if (!allocs.length) return none;
    await this.ledger.lockMember(q, c.memberId);
    const v = await this.programme.byId(q, allocs[0].versionId);
    const s = v.settings;
    const byLine = new Map(r.lines.map((l) => [l.lineId, l]));
    const input = allocs.map((a) => {
      const x = byLine.get(a.lineId);
      // Lines not in this return are kept whole, unless an earlier return took them.
      return {
        eligibleBefore: a.eligible ? a.eligibleBefore : '0.00',
        points: a.points,
        wallet: a.wallet,
        keptFraction: x ? x.kept : '1',
        returnedFraction: x ? x.returned : '0',
        lineId: a.lineId,
      };
    });
    // Earlier returns on the same check reduce what is kept.
    const { rows: earlier } = await q.query<{ lineId: string; fraction: string }>(
      `SELECT rl.line_id AS "lineId", (sum(rl.quantity) / l.quantity)::text AS fraction FROM pos_return_lines rl JOIN pos_check_lines l ON l.id = rl.line_id
        WHERE l.check_id = $1 AND rl.return_id <> $2 GROUP BY rl.line_id, l.quantity`,
      [r.checkId, r.returnId],
    );
    for (const e of earlier) {
      const i = input.find((x) => x.lineId === e.lineId);
      if (i && !byLine.has(e.lineId)) i.keptFraction = new Decimal(1).minus(e.fraction).toString();
    }
    const { rows: [earn] } = await q.query<{ n: string; earnId: string | null }>(
      `SELECT coalesce(sum(amount), 0)::text AS n, (SELECT id::text FROM loyalty_events WHERE event_key = $2) AS "earnId"
         FROM loyalty_events WHERE check_id = $1 AND unit = 'points' AND type IN ('earn', 'reverse')`,
      [r.checkId, `earn:check:${r.checkId}`],
    );
    const effect = returnEffect(input, Number(earn.n), s.points.earnUnit, s.points.pointValue);
    const ctx = { propertyId: r.propertyId, outletId: c.outletId, businessDate: r.businessDate, checkId: r.checkId, returnId: r.returnId, programmeVersionId: v.id };
    for (const [unit, amount] of [['points', String(effect.restorePoints)], ['wallet', effect.restoreWallet]] as const) {
      if (new Decimal(amount).isZero()) continue;
      const { rows: [red] } = await q.query<{ id: string }>('SELECT id::text FROM loyalty_events WHERE event_key = $1', [`redeem:${r.checkId}:${unit}`]);
      if (!red) continue;
      await this.ledger.restore(q, {
        ...ctx, key: `return:${r.returnId}:${unit}:restore`, memberId: c.memberId, unit, amount,
        value: unit === 'points' ? new Decimal(amount).times(s.points.pointValue).toFixed(2) : amount, fromEventId: red.id, graceDays: s.points.restoreGraceDays,
        reason: `Returned items on ${c.number}`,
      });
    }
    if (effect.reversePoints > 0 && earn.earnId) {
      await this.ledger.post(q, {
        ...ctx, key: `return:${r.returnId}:points:reverse`, memberId: c.memberId, unit: 'points', type: 'reverse', amount: String(-effect.reversePoints),
        value: new Decimal(-effect.reversePoints).times(s.points.pointValue).toFixed(2), originalEventId: earn.earnId, preferSourceEventId: earn.earnId,
        allowDeficit: true, reason: `Returned items on ${c.number}`, details: { retainedEligible: effect.retainedEligible },
      });
    }
    // Cashback: a negative accrual in the original sale's month at its original rate (CLUB06).
    const { rows: [acc] } = await q.query<{ id: string; month: string; rate: string; saleDate: string }>(
      `SELECT id::text, settlement_month AS month, rate_percent::text AS rate, sale_date AS "saleDate" FROM cashback_accruals WHERE accrual_key = $1`,
      [`cb:check:${r.checkId}`],
    );
    if (acc) {
      const back = allocs.reduce((sum, a) => {
        const x = byLine.get(a.lineId);
        return x && a.eligible ? sum.plus(new Decimal(a.paidShare).times(x.returned)) : sum;
      }, new Decimal(0));
      if (back.gt(0)) {
        await this.accrue(q, {
          key: `cb:return:${r.returnId}`, memberId: c.memberId, propertyId: r.propertyId, outletId: c.outletId, checkId: r.checkId, returnId: r.returnId,
          kind: 'return', saleDate: acc.saleDate, month: acc.month, eligible: back.negated().toFixed(2), rate: acc.rate, rateSource: 'sale', originalId: acc.id,
        });
      }
    }
    return { pointsRestored: effect.restorePoints, pointsReversed: effect.reversePoints, walletRestored: effect.restoreWallet };
  }

  /** For the receipt (LOY17): what the bill did, without personal details. */
  async receipt(q: Queryable, checkId: string) {
    const { rows: [o] } = await q.query(
      `SELECT m.number, o.points_earned AS "pointsEarned", o.points_pending AS "pointsPending", o.points_redeemed AS "pointsRedeemed",
              o.wallet_redeemed::text AS "walletRedeemed", o.member_discount::text AS "memberDiscount", o.cashback_pending::text AS "cashbackPending",
              o.closing_points AS "closingPoints", o.closing_wallet::text AS "closingWallet", o.note
         FROM loyalty_check_outcomes o JOIN loyalty_members m ON m.id = o.member_id WHERE o.check_id = $1`,
      [checkId],
    );
    if (o) return { ...o, number: `${'•'.repeat(4)}${String(o.number).slice(-4)}`, final: true };
    const { rows: [open] } = await q.query(
      `SELECT m.number, coalesce(sum(l.reward_points), 0)::int AS "pointsRedeemed", coalesce(sum(l.reward_wallet), 0)::text AS "walletRedeemed",
              coalesce(sum(l.member_discount_amount), 0)::text AS "memberDiscount"
         FROM pos_checks c JOIN loyalty_members m ON m.id = c.loyalty_member_id
         LEFT JOIN pos_check_lines l ON l.check_id = c.id AND l.status NOT IN ('cancelled', 'wasted')
        WHERE c.id = $1 GROUP BY m.number`,
      [checkId],
    );
    return open ? { ...open, number: `${'•'.repeat(4)}${String(open.number).slice(-4)}`, final: false } : null;
  }
}
