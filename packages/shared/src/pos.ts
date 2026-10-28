import { Money } from './money';
import { addDays, isoWeekday } from './frontdesk';

/**
 * Restaurant, bar and kitchen POS vocabulary (POS-04, POS-06, POS-11) and the
 * pure rules shared by the API, the waiter PWA and the back office: trading
 * dates from the business-day cut-off (§9), liquor-licence hours (POS-17),
 * scheduled price rules (POS-03) and line pricing.
 */

export const SERVICE_TYPES = ['table', 'counter', 'takeaway', 'room_service'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const LINE_STATUSES = ['draft', 'sent', 'preparing', 'ready', 'served', 'cancelled', 'wasted'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
/** Lines that count towards the bill. */
export const LIVE_LINE_STATUSES: readonly LineStatus[] = ['draft', 'sent', 'preparing', 'ready', 'served'];
/** Lines the kitchen or bar may already have made: cancelling them is waste (POS-11). */
export const PREPARED_LINE_STATUSES: readonly LineStatus[] = ['preparing', 'ready', 'served'];

export const CHECK_STATUSES = ['open', 'closed', 'void', 'merged'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const TICKET_STATUSES = ['new', 'preparing', 'ready', 'done'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Tenders taken at the POS (POS-10). Credit to a company is a front-desk action. */
export const POS_TENDERS = ['cash', 'mpesa', 'card', 'bank_transfer', 'other'] as const;
export type PosTender = (typeof POS_TENDERS)[number];

export const HOUSE_ACCOUNT_KINDS = ['staff_meals', 'director', 'entertainment', 'other'] as const;

// ---------------------------------------------------------------------------
// Local time and trading dates
// ---------------------------------------------------------------------------
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;
const TIME_RE = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/** Minutes since midnight for "HH:MM" or "HH:MM:SS". */
export function minutesOf(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time ${time}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time ${time}`);
  return h * 60 + min;
}

/** Splits a local wall-clock timestamp "YYYY-MM-DDTHH:MM[:SS]" into date and minutes. */
export function parseLocal(local: string): { date: string; minutes: number } {
  const m = LOCAL_RE.exec(local);
  if (!m) throw new Error(`Invalid local timestamp ${local}`);
  return { date: m[1], minutes: Number(m[2]) * 60 + Number(m[3]) };
}

/**
 * The trading date a moment belongs to: time before the cut-off belongs to the
 * previous day (§9; 08:00 for all three properties, Manish Khatri 28 Oct 2026).
 * `local` is wall-clock time at the property.
 */
export function tradingDate(local: string, cutoff: string): string {
  const { date, minutes } = parseLocal(local);
  return minutes < minutesOf(cutoff) ? addDays(date, -1) : date;
}

/**
 * The date an outlet's next trading day gets: the clock's trading date, but
 * never before the property's open business date (closed dates are locked,
 * BIL-10) and at most one day ahead of it, so the night audit is never skipped.
 */
export function outletTradingDate(local: string, cutoff: string, propertyBusinessDate: string): string {
  const t = tradingDate(local, cutoff);
  if (t < propertyBusinessDate) return propertyBusinessDate;
  const latest = addDays(propertyBusinessDate, 1);
  return t > latest ? latest : t;
}

// ---------------------------------------------------------------------------
// Liquor-licence hours (POS-17)
// ---------------------------------------------------------------------------
export interface LiquorWindow {
  weekday: number; // 1 = Monday … 7 = Sunday
  opensAt: string; // HH:MM
  closesAt: string; // HH:MM; at or before opensAt = runs past midnight
}

/**
 * Whether alcohol may be sold at this local time. A window that runs past
 * midnight belongs to the day it opened: Friday 18:00–02:00 covers Saturday 01:30.
 */
export function liquorAllowed(windows: readonly LiquorWindow[], local: string): boolean {
  const { date, minutes } = parseLocal(local);
  const today = isoWeekday(date);
  const yesterday = today === 1 ? 7 : today - 1;
  return windows.some((w) => {
    const open = minutesOf(w.opensAt);
    const close = minutesOf(w.closesAt);
    const overnight = close <= open;
    if (w.weekday === today) return overnight ? minutes >= open : minutes >= open && minutes < close;
    if (w.weekday === yesterday && overnight) return minutes < close;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Scheduled price rules (POS-03 happy hour)
// ---------------------------------------------------------------------------
export interface PriceRuleWindow {
  weekdays: readonly number[];
  startsAt: string;
  endsAt: string;
  validFrom: string;
  validTo: string | null;
}

/** Whether a rule applies at this local wall-clock time (same-day windows only). */
export function ruleApplies(rule: PriceRuleWindow, local: string): boolean {
  const { date, minutes } = parseLocal(local);
  if (date < rule.validFrom || (rule.validTo !== null && date > rule.validTo)) return false;
  if (!rule.weekdays.includes(isoWeekday(date))) return false;
  return minutes >= minutesOf(rule.startsAt) && minutes < minutesOf(rule.endsAt);
}

// ---------------------------------------------------------------------------
// Line pricing. Prices include VAT and levy; discounts reduce the inclusive
// amount, and tax is then split out of what the guest pays (BIL-08).
// ---------------------------------------------------------------------------
export interface LinePriceInput {
  unitPrice: string;
  modifiersUnitPrice?: string;
  quantity: string;
  /** Scheduled discount (happy hour) in percent, applied first. */
  rulePercent?: string;
  /** Manual discount in percent, applied to what is left after the rule. */
  discountPercent?: string;
}

export interface LinePrice {
  gross: string;
  ruleDiscount: string;
  discount: string;
  amount: string;
}

export function priceLine(input: LinePriceInput): LinePrice {
  const unit = Money.of(input.unitPrice).add(input.modifiersUnitPrice ?? '0');
  const gross = unit.multiply(input.quantity);
  const rule = gross.multiply(input.rulePercent ?? '0').divide(100);
  const afterRule = gross.subtract(rule);
  const pct = input.discountPercent ?? '0';
  // 100% is a comp: nothing left to pay, however the cents fall.
  const discount = Money.of(pct).equals(100) ? afterRule : afterRule.multiply(pct).divide(100);
  const amount = afterRule.subtract(discount);
  return { gross: gross.toString(), ruleDiscount: rule.toString(), discount: discount.toString(), amount: amount.toString() };
}

/**
 * Spreads an amount (e.g. the unpaid part of a check charged to a room) over
 * the lines in proportion to their amounts, without losing a cent (AT-07).
 */
export function spreadOverLines(total: string, lineAmounts: readonly string[]): string[] {
  const weights = lineAmounts.map((a) => Money.of(a).toString());
  if (weights.every((w) => Money.of(w).isZero())) return weights.map(() => '0.00');
  return Money.of(total)
    .allocate(weights)
    .map((m) => m.toString());
}
