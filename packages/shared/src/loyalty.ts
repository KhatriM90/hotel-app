import Decimal from 'decimal.js';
import { Money } from './money';

/**
 * Loyalty and club membership (addendum v1.2: LOY01, LOY05, LOY11–LOY28,
 * CLUB01–CLUB07). Pure rules shared by the API, the back office and the waiter
 * tablets. Every rate here is a configurable programme setting; the defaults
 * are the addendum's proposed values for demonstration, not approved terms.
 */

export const LOYALTY_UNITS = ['points', 'wallet'] as const;
export type LoyaltyUnit = (typeof LOYALTY_UNITS)[number];

export const MEMBER_STATUSES = ['active', 'suspended', 'closed', 'merged', 'anonymised'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const CLUB_STATUSES = ['active', 'suspended', 'expired'] as const;

export const LOYALTY_EVENT_TYPES = ['earn', 'redeem', 'restore', 'reverse', 'adjust', 'expire', 'merge_in', 'merge_out', 'credit'] as const;
export type LoyaltyEventType = (typeof LOYALTY_EVENT_TYPES)[number];

/** Booking sources that count as direct (LOY27); agents and OTAs are not. */
export const DIRECT_BOOKING_SOURCES = ['walk_in', 'phone', 'email', 'website'] as const;

export interface LoyaltySettings {
  points: {
    /** KES of eligible spend per point (LOY01). */
    earnUnit: string;
    /** KES value of one point when redeemed (LOY01). */
    pointValue: string;
    minRedeemPoints: number;
    /** Share of the eligible bill before redemption that points may pay (LOY13). */
    redeemCapPercent: string;
    /** Each earned lot expires this many months after it becomes available (LOY14). */
    expiryMonths: number;
    /** Restored points whose lot already expired get this many days (LOY14). */
    restoreGraceDays: number;
    /** Most points one member may earn in one business day; null for no cap (LOY22). */
    dailyEarnCap: number | null;
  };
  eligibility: {
    /** 'net' excludes VAT and catering levy from eligible spend (LOY20). */
    basis: 'net' | 'gross';
    excludedChargeCodes: string[];
    excludedCategoryCodes: string[];
    excludedItemCodes: string[];
    /** Outlets that take part; empty means all (LOY05). */
    participatingOutletCodes: string[];
    /** Member discounts and point or wallet rewards on alcohol (LOY25). Off until legal confirms. */
    rewardsOnAlcohol: boolean;
  };
  rooms: {
    /** Booking sources whose room revenue earns (LOY27). */
    earningSources: string[];
    /** Corporate bookings (with a company) earn whatever their source. */
    corporateEarns: boolean;
    excludedRatePlanCodes: string[];
  };
  stacking: {
    /** Off: one benefit per bill (CLUB02, LOY26). */
    enabled: boolean;
    /** Most the bill's benefits may take off when stacking is on (LOY26). */
    ceilingPercent: string;
  };
  club: {
    defaultDiscountPercent: string;
    defaultCashbackPercent: string;
    /** With stacking off, the benefit a club member gets by default. */
    benefitWhenNotStacking: 'discount' | 'cashback';
    /** Whether club members also earn points (decision 2: cashback only). */
    earnsPoints: boolean;
    minMonthlySpend: string;
    /** Monthly credit cap per member; null for none (CLUB03). */
    monthlyCap: string | null;
    /** Share of an eligible bill wallet credit may pay (CLUB05). */
    walletCapPercent: string;
    walletExpiryMonths: number;
  };
  verification: {
    /** 'screen' shows the code to staff (demo only); 'sms' needs a gateway. */
    otpDelivery: 'screen' | 'sms';
    otpMinutes: number;
    maxAttempts: number;
  };
  /** How long reserved points or credit are held while checkout is active (LOY13). */
  reservationMinutes: number;
  misuse: {
    /** Flagged staff earn nothing on bills they serve, cash or are on shift for (LOY22). */
    staffEarnsOnOwnBills: boolean;
    billsPerDayAlert: number;
    waiterSharePercentAlert: number;
  };
  /** How a reward shows on the bill and in SAP (LOY20, decision 1). */
  rewardTreatment: 'discount' | 'tender';
  /** GL accounts for loyalty journals; finance must approve before activation (LOY18, CLUB07). */
  sapAccounts: { cashbackExpense: string; walletLiability: string };
}

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  points: { earnUnit: '100.00', pointValue: '1.00', minRedeemPoints: 100, redeemCapPercent: '20', expiryMonths: 12, restoreGraceDays: 30, dailyEarnCap: 5000 },
  eligibility: {
    basis: 'net',
    excludedChargeCodes: ['CANCEL_FEE', 'NO_SHOW_FEE'],
    excludedCategoryCodes: [],
    excludedItemCodes: [],
    participatingOutletCodes: [],
    rewardsOnAlcohol: false,
  },
  rooms: { earningSources: [...DIRECT_BOOKING_SOURCES], corporateEarns: true, excludedRatePlanCodes: ['COMP', 'STAFF'] },
  stacking: { enabled: false, ceilingPercent: '25' },
  club: {
    defaultDiscountPercent: '10',
    defaultCashbackPercent: '15',
    benefitWhenNotStacking: 'discount',
    earnsPoints: false,
    minMonthlySpend: '0.00',
    monthlyCap: null,
    walletCapPercent: '100',
    walletExpiryMonths: 12,
  },
  verification: { otpDelivery: 'screen', otpMinutes: 5, maxAttempts: 5 },
  reservationMinutes: 15,
  misuse: { staffEarnsOnOwnBills: false, billsPerDayAlert: 10, waiterSharePercentAlert: 60 },
  rewardTreatment: 'discount',
  sapAccounts: { cashbackExpense: '', walletLiability: '' },
};

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** Earned points = floor(eligible spend / earning unit), once per earning event (LOY12). */
export function pointsEarned(eligible: string, earnUnit: string): number {
  const e = new Decimal(eligible);
  if (e.lte(0)) return 0;
  return e.dividedBy(earnUnit).floor().toNumber();
}

/** Monetary value of points at the configured conversion rate. */
export function pointsValue(points: number, pointValue: string): string {
  return Money.of(new Decimal(points).times(pointValue).toFixed(2)).toString();
}

/**
 * Most points a bill may take (LOY13): the cap share of the eligible value
 * before redemption, never more than is available, and nothing below the
 * minimum redemption.
 */
export function maxRedeemablePoints(input: { eligible: string; capPercent: string; pointValue: string; available: number; minRedeem: number }): number {
  const byCap = new Decimal(input.eligible).times(input.capPercent).dividedBy(100).dividedBy(input.pointValue).floor().toNumber();
  const most = Math.max(0, Math.min(byCap, input.available));
  return most < input.minRedeem ? 0 : most;
}

/**
 * Splits a whole number over weights so the parts add up exactly (largest
 * remainder, ties to the earlier line). Used to allocate redeemed points to
 * eligible lines, so a return can restore exactly what each line used (LOY12).
 */
export function allocateWhole(total: number, weights: readonly string[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Cannot allocate ${total}`);
  const ws = weights.map((w) => new Decimal(w));
  const sum = ws.reduce((a, b) => a.plus(b), new Decimal(0));
  if (sum.lte(0)) return ws.map(() => 0);
  const raw = ws.map((w) => w.times(total).dividedBy(sum));
  const parts = raw.map((r) => r.floor().toNumber());
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r.minus(r.floor()) })).sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i] += 1;
  return parts;
}

/** Money version of allocateWhole, to the cent. */
export function allocateMoney(total: string, weights: readonly string[]): string[] {
  if (weights.every((w) => new Decimal(w).lte(0))) return weights.map(() => '0.00');
  return Money.of(total)
    .allocate(weights.map((w) => (new Decimal(w).lt(0) ? '0' : w)))
    .map((m) => m.toString());
}

/**
 * How much the tax-inclusive line price falls when `value` of eligible value is
 * taken off it. With a net basis a reward lowers the taxable value, so the
 * gross falls by the value plus its tax (decision 1: discount treatment).
 */
export function grossReduction(value: string, lineGross: string, lineEligible: string, basis: 'net' | 'gross'): string {
  if (basis === 'gross' || new Decimal(lineEligible).isZero()) return Money.of(value).toString();
  const g = Money.of(new Decimal(value).times(lineGross).dividedBy(lineEligible).toFixed(6));
  return (g.compare(lineGross) > 0 ? Money.of(lineGross) : g).toString();
}

export interface ReturnLineInput {
  /** Eligible value of the line after discounts, before any reward. */
  eligibleBefore: string;
  /** Points allocated to the line when the bill was redeemed. */
  points: number;
  /** Wallet credit allocated to the line. */
  wallet: string;
  /** Share of the line still kept by the guest after this return, 0 to 1. */
  keptFraction: string;
  /** Share being returned now, 0 to 1. */
  returnedFraction: string;
}

/**
 * A return under the original rules (S15, S16, LAT05): restores the returned
 * lines' allocated redemption and recomputes earning on what the guest keeps.
 * `earnedSoFar` is the original award less any earlier reversals.
 */
export function returnEffect(lines: readonly ReturnLineInput[], earnedSoFar: number, earnUnit: string, pointValue = '1.00'): {
  restorePoints: number;
  restoreWallet: string;
  retainedEligible: string;
  reversePoints: number;
} {
  let restorePoints = 0;
  let restoreWallet = Money.zero();
  let retained = new Decimal(0);
  for (const l of lines) {
    const after = new Decimal(l.eligibleBefore).minus(new Decimal(l.points).times(pointValue)).minus(l.wallet);
    restorePoints += new Decimal(l.points).times(l.returnedFraction).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
    restoreWallet = restoreWallet.add(Money.of(new Decimal(l.wallet).times(l.returnedFraction).toFixed(6)));
    retained = retained.plus(after.times(l.keptFraction));
  }
  const retainedEligible = Money.of(retained.toFixed(6)).toString();
  const shouldHave = pointsEarned(retainedEligible, earnUnit);
  return { restorePoints, restoreWallet: restoreWallet.toString(), retainedEligible, reversePoints: Math.max(0, earnedSoFar - shouldHave) };
}

// ---------------------------------------------------------------------------
// Club membership: rates, benefits and monthly cashback (CLUB01–CLUB06)
// ---------------------------------------------------------------------------

export interface ClubRates {
  discountPercent: string;
  cashbackPercent: string;
  source: { discount: 'override' | 'tier' | 'programme'; cashback: 'override' | 'tier' | 'programme' };
}

/** Approved individual override, then tier, then programme default (CLUB01). */
export function resolveClubRates(
  override: { discountPercent: string | null; cashbackPercent: string | null } | null,
  tier: { discountPercent: string | null; cashbackPercent: string | null } | null,
  programme: { discountPercent: string; cashbackPercent: string },
): ClubRates {
  const pick = (k: 'discountPercent' | 'cashbackPercent') =>
    override?.[k] != null
      ? { v: override[k]!, s: 'override' as const }
      : tier?.[k] != null
        ? { v: tier[k]!, s: 'tier' as const }
        : { v: programme[k], s: 'programme' as const };
  const d = pick('discountPercent');
  const c = pick('cashbackPercent');
  return { discountPercent: d.v, cashbackPercent: c.v, source: { discount: d.s, cashback: c.s } };
}

export interface CashbackItem {
  eligible: string;
  ratePercent: string;
}

/**
 * A member's credit for one month (CLUB03): eligible amounts times their
 * sale-time rates, summed and rounded once to the cent, then the minimum
 * monthly spend and the cap. Returns are negative items, so a refund lowers the
 * base and the cap is applied to what is left (CAT07, CAT09).
 */
export function monthlyCashback(items: readonly CashbackItem[], minSpend: string, cap: string | null): {
  spend: string;
  raw: string;
  credit: string;
  belowMinimum: boolean;
  capped: boolean;
} {
  const spend = items.reduce((a, i) => a.plus(i.eligible), new Decimal(0));
  const raw = items.reduce((a, i) => a.plus(new Decimal(i.eligible).times(i.ratePercent).dividedBy(100)), new Decimal(0));
  const rounded = Money.of(raw.toFixed(6));
  const belowMinimum = spend.lt(minSpend) || spend.lte(0);
  let credit = belowMinimum || rounded.isNegative() ? Money.zero() : rounded;
  const capped = cap !== null && credit.compare(cap) > 0;
  if (capped) credit = Money.of(cap!);
  return { spend: Money.of(spend.toFixed(6)).toString(), raw: raw.toFixed(6), credit: credit.toString(), belowMinimum, capped };
}

/**
 * Most the bill's benefits may take off when stacking is on (LOY26): the
 * ceiling share of the bill before any benefit, less benefits already given.
 */
export function ceilingRoom(billBeforeBenefits: string, ceilingPercent: string, alreadyGiven: string): string {
  const ceiling = Money.of(new Decimal(billBeforeBenefits).times(ceilingPercent).dividedBy(100).toFixed(6));
  const room = ceiling.subtract(alreadyGiven);
  return room.isNegative() ? '0.00' : room.toString();
}

/** First day of the month an ISO date falls in. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Adds whole months to an ISO timestamp or date, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso.length === 10 ? d.toISOString().slice(0, 10) : d.toISOString();
}

/** Member number check: "YS" and six or more digits. */
export function isMemberNumber(v: string): boolean {
  return /^YS\d{6,}$/.test(v.trim().toUpperCase());
}

/** QR payload on a member card: YS:<number>:<secret>. */
export function parseMemberQr(v: string): { number: string; token: string } | null {
  const m = /^YS:(YS\d{6,}):([A-Za-z0-9_-]{16,64})$/.exec(v.trim());
  return m ? { number: m[1], token: m[2] } : null;
}

/** Shows only the last three digits of a phone number to POS staff (LOY15). */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 3 ? '•••' : `••• ${digits.slice(-3)}`;
}
