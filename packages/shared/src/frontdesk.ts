import { Money } from './money';

/**
 * Reservations, front desk and folio vocabulary (RES-02, RES-03, FD-07, BIL-06)
 * and the pure pricing rules shared by the API and the back office.
 */

/** Booking lifecycle (RES-03). Allowed transitions are enforced in Postgres (stay_status_transitions). */
export const STAY_STATUSES = ['enquiry', 'hold', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'] as const;
export type StayStatus = (typeof STAY_STATUSES)[number];

export const STAY_TRANSITIONS: Readonly<Record<StayStatus, readonly StayStatus[]>> = {
  enquiry: ['hold', 'confirmed', 'cancelled'],
  hold: ['confirmed', 'enquiry', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: StayStatus, to: StayStatus): boolean {
  return STAY_TRANSITIONS[from].includes(to);
}

export const BOOKING_SOURCES = ['walk_in', 'phone', 'email', 'agent', 'website', 'other'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const HK_STATUSES = ['clean', 'inspected', 'dirty', 'in_progress'] as const;
export type HkStatus = (typeof HK_STATUSES)[number];
/** Rooms reception may hand to a guest (FD-03). */
export const READY_HK_STATUSES: readonly HkStatus[] = ['clean', 'inspected'];

export const PAYMENT_TENDERS = ['cash', 'mpesa', 'card', 'bank_transfer', 'cheque', 'city_ledger', 'other'] as const;
export type PaymentTender = (typeof PAYMENT_TENDERS)[number];
/** Tenders that need a provider reference, which must be unique (BIL-04, AT-03). */
export const REFERENCED_TENDERS: readonly PaymentTender[] = ['mpesa', 'card', 'bank_transfer', 'cheque'];

export const GUEST_REQUEST_CATEGORIES = ['maintenance', 'linen', 'wake_up', 'housekeeping', 'transport', 'other'] as const;
export const GUEST_REQUEST_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;

export const IDENTITY_DOCUMENT_TYPES = ['national_id', 'passport', 'alien_id', 'driving_licence', 'other'] as const;

// ---------------------------------------------------------------------------
// Dates. Business dates are plain ISO dates (YYYY-MM-DD) with no time zone.
// ---------------------------------------------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(date: string): Date {
  if (!ISO_DATE.test(date)) throw new Error(`Invalid ISO date ${date}`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new Error(`Invalid ISO date ${date}`);
  return d;
}

export function addDays(date: string, days: number): string {
  const d = parseIso(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nights of a stay: every date from arrival up to, not including, departure. */
export function nightsBetween(arrival: string, departure: string): string[] {
  const nights: string[] = [];
  for (let d = arrival; d < departure; d = addDays(d, 1)) nights.push(d);
  return nights;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = parseIso(date).getUTCDay();
  return day === 0 ? 7 : day;
}

// ---------------------------------------------------------------------------
// Night pricing (RES-05)
// ---------------------------------------------------------------------------
export interface NightPriceRule {
  weekdayPrice: string;
  weekendPrice: string;
  extraAdultPrice: string;
  childPrice: string;
  /** ISO weekdays of nights priced at the weekend rate; default Friday and Saturday nights. */
  weekendDays: readonly number[];
  baseOccupancy: number;
  seasonName?: string;
}

export interface NightPrice {
  date: string;
  base: string;
  supplement: string;
  amount: string;
  weekend: boolean;
  seasonName?: string;
}

/**
 * Price of one night. The room price covers `baseOccupancy` guests; adults fill
 * those places first and children use any left free. Each further adult pays the
 * extra-adult supplement and each further child the child supplement.
 */
export function priceNight(rule: NightPriceRule, date: string, adults: number, children: number): NightPrice {
  const weekend = rule.weekendDays.includes(isoWeekday(date));
  const base = Money.of(weekend ? rule.weekendPrice : rule.weekdayPrice);
  const extraAdults = Math.max(0, adults - rule.baseOccupancy);
  const freeChildPlaces = Math.max(0, rule.baseOccupancy - adults);
  const payingChildren = Math.max(0, children - freeChildPlaces);
  const supplement = Money.of(rule.extraAdultPrice).multiply(extraAdults).add(Money.of(rule.childPrice).multiply(payingChildren));
  return {
    date,
    base: base.toString(),
    supplement: supplement.toString(),
    amount: base.add(supplement).toString(),
    weekend,
    seasonName: rule.seasonName,
  };
}

// ---------------------------------------------------------------------------
// Tax-inclusive split (BIL-01, BIL-08, BIL-16)
// ---------------------------------------------------------------------------
export interface TaxRate {
  code: string;
  /** Percentage, e.g. "16" for 16% VAT, "2" for the 2% catering levy. */
  ratePercent: string;
}

export interface TaxSplit {
  gross: string;
  net: string;
  tax: string;
  lines: Array<{ code: string; ratePercent: string; taxable: string; amount: string }>;
}

/**
 * Splits a tax-inclusive amount into net and one line per tax, each on the same
 * net base (VAT and catering levy are both charged on the net price). Lines are
 * rounded half-up to the cent; any rounding difference goes to the largest tax,
 * so net + taxes always equals the gross exactly. Works for negative amounts
 * (reversals) by symmetry. Provisional until the accountant signs off (BIL-08).
 */
export function splitInclusiveTax(gross: string, rates: readonly TaxRate[]): TaxSplit {
  const g = Money.of(gross);
  if (rates.length === 0) return { gross: g.toString(), net: g.toString(), tax: '0.00', lines: [] };
  const totalRate = rates.reduce((acc, r) => acc.add(r.ratePercent), Money.of(0)); // percent with 2dp is enough for KRA rates
  const divisor = Money.of(100).add(totalRate).divide(100).toString();
  const net = g.divide(divisor);
  const lines = rates.map((r) => ({
    code: r.code,
    ratePercent: Money.of(r.ratePercent).toString(),
    taxable: net.toString(),
    amount: net.multiply(r.ratePercent).divide(100),
  }));
  const diff = g.subtract(net).subtract(Money.sum(lines.map((l) => l.amount)));
  if (!diff.isZero()) {
    let largest = 0;
    lines.forEach((l, i) => {
      if (Money.of(l.ratePercent).compare(lines[largest].ratePercent) > 0) largest = i;
    });
    lines[largest].amount = lines[largest].amount.add(diff);
  }
  const tax = Money.sum(lines.map((l) => l.amount));
  return {
    gross: g.toString(),
    net: net.toString(),
    tax: tax.toString(),
    lines: lines.map((l) => ({ ...l, amount: l.amount.toString() })),
  };
}

// ---------------------------------------------------------------------------
// Deposits and cancellation charges (RES-07)
// ---------------------------------------------------------------------------
export interface BookingPolicy {
  depositType: 'none' | 'percent' | 'nights';
  depositValue: string;
  depositDueDays: number;
  freeCancellationHours: number;
  lateCancellationNights: number;
  noShowNights: number;
}

/** Deposit required for a stay given its agreed night prices, in night order. */
export function depositFor(policy: BookingPolicy, nightAmounts: readonly string[]): string {
  const total = Money.sum(nightAmounts.map((a) => Money.of(a)));
  switch (policy.depositType) {
    case 'none':
      return '0.00';
    case 'percent':
      return total.multiply(policy.depositValue).divide(100).toString();
    case 'nights': {
      const n = Math.max(0, Math.floor(Number(policy.depositValue)));
      return Money.sum(nightAmounts.slice(0, n).map((a) => Money.of(a))).toString();
    }
  }
}

/** Deposit due date: N days before arrival, but never before the booking date. */
export function depositDueDate(policy: BookingPolicy, bookedOn: string, arrival: string): string {
  const due = addDays(arrival, -policy.depositDueDays);
  return due < bookedOn ? bookedOn : due;
}

/** Sum of the first `nights` agreed night prices; the basis of cancellation and no-show charges. */
export function firstNightsCharge(nights: number, nightAmounts: readonly string[]): string {
  return Money.sum(nightAmounts.slice(0, Math.max(0, nights)).map((a) => Money.of(a))).toString();
}

/**
 * Cancellation charge (RES-07): free until `freeCancellationHours` before the
 * arrival day's check-in time, then `lateCancellationNights` nights.
 */
export function cancellationCharge(
  policy: BookingPolicy,
  nightAmounts: readonly string[],
  now: Date,
  arrivalCheckIn: Date,
): string {
  const hoursBefore = (arrivalCheckIn.getTime() - now.getTime()) / 3_600_000;
  if (hoursBefore >= policy.freeCancellationHours) return '0.00';
  return firstNightsCharge(policy.lateCancellationNights, nightAmounts);
}
