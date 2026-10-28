import Decimal from 'decimal.js';

/**
 * Decimal money (brief §9: "Use decimal money and consistent rounding").
 *
 * - Never constructed from a JS floating-point number with a fractional part.
 * - Amounts are stored and serialised as strings with exactly `scale` decimals.
 * - Rounding is ROUND_HALF_UP to the currency's minor unit. The rounding rule is
 *   provisional until the accountant signs off tax/rounding policy (BIL-08).
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type CurrencyCode = 'KES' | 'USD' | 'EUR' | 'GBP';

const CURRENCY_SCALE: Record<CurrencyCode, number> = { KES: 2, USD: 2, EUR: 2, GBP: 2 };

/** Max digits allowed by the `money_amount` Postgres domain: numeric(18,2). */
const MAX_ABS = new D('9999999999999999.99');

export type MoneyInput = string | bigint | number | Money;

export class MoneyError extends Error {}

function toDecimal(value: string | bigint | number): Decimal {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(
        `Refusing to build money from non-integer JS number ${value}; pass a decimal string instead`,
      );
    }
    return new D(value);
  }
  if (typeof value === 'bigint') return new D(value.toString());
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Invalid decimal amount "${value}"`);
  }
  return new D(trimmed);
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: CurrencyCode,
  ) {}

  /** Builds an amount and rounds it to the currency's minor unit. */
  static of(value: string | bigint | number, currency: CurrencyCode = 'KES'): Money {
    const scale = CURRENCY_SCALE[currency];
    if (scale === undefined) throw new MoneyError(`Unsupported currency ${currency}`);
    const d = toDecimal(value).toDecimalPlaces(scale, D.ROUND_HALF_UP);
    if (d.abs().greaterThan(MAX_ABS)) throw new MoneyError(`Amount ${d.toFixed()} exceeds storage range`);
    return new Money(d, currency);
  }

  static zero(currency: CurrencyCode = 'KES'): Money {
    return Money.of(0, currency);
  }

  static sum(items: Money[], currency: CurrencyCode = 'KES'): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  get scale(): number {
    return CURRENCY_SCALE[this.currency];
  }

  private coerce(other: MoneyInput): Money {
    if (other instanceof Money) {
      if (other.currency !== this.currency) {
        throw new MoneyError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
      }
      return other;
    }
    return Money.of(other, this.currency);
  }

  add(other: MoneyInput): Money {
    return Money.of(this.value.plus(this.coerce(other).value).toFixed(), this.currency);
  }

  subtract(other: MoneyInput): Money {
    return Money.of(this.value.minus(this.coerce(other).value).toFixed(), this.currency);
  }

  /** Multiplies by a quantity or rate given as a decimal string (e.g. "1.5", "0.16"). */
  multiply(factor: string | bigint | number): Money {
    return Money.of(this.value.times(toDecimal(factor)).toFixed(), this.currency);
  }

  /** Divides by a decimal string (e.g. "1.18" to take tax out of an inclusive price). */
  divide(divisor: string | bigint | number): Money {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new MoneyError('Division by zero');
    return Money.of(this.value.dividedBy(d).toFixed(), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated().toFixed(), this.currency);
  }

  /**
   * Splits the amount by integer/decimal weights so that the parts always sum
   * exactly to the original (largest-remainder method). Used for split bills
   * and company/guest allocations (BIL-05, POS-08, AT-07).
   */
  allocate(weights: Array<string | number>): Money[] {
    if (weights.length === 0) throw new MoneyError('allocate() needs at least one weight');
    const ws = weights.map((w) => toDecimal(w));
    if (ws.some((w) => w.isNegative())) throw new MoneyError('Weights must be non-negative');
    const total = ws.reduce((a, b) => a.plus(b), new D(0));
    if (total.isZero()) throw new MoneyError('Weights must not all be zero');

    const unit = new D(1).dividedBy(new D(10).pow(this.scale));
    const minorTotal = this.value.dividedBy(unit); // integer number of minor units
    const raw = ws.map((w) => minorTotal.times(w).dividedBy(total));
    const floored = raw.map((r) => r.toDecimalPlaces(0, D.ROUND_FLOOR));
    let remainder = minorTotal.minus(floored.reduce((a, b) => a.plus(b), new D(0)));
    const order = raw
      .map((r, i) => ({ i, frac: r.minus(floored[i]) }))
      .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
    const result = [...floored];
    for (let k = 0; remainder.greaterThan(0); k = (k + 1) % order.length) {
      result[order[k].i] = result[order[k].i].plus(1);
      remainder = remainder.minus(1);
    }
    return result.map((minor) => Money.of(minor.times(unit).toFixed(), this.currency));
  }

  equals(other: MoneyInput): boolean {
    return this.value.equals(this.coerce(other).value);
  }

  compare(other: MoneyInput): -1 | 0 | 1 {
    return this.value.comparedTo(this.coerce(other).value) as -1 | 0 | 1;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  /** Canonical string with exactly `scale` decimals, e.g. "16500.00". Use for APIs and SQL. */
  toString(): string {
    return this.value.toFixed(this.scale);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Display string, e.g. "KES 16,500.00". */
  format(): string {
    const [int, frac] = this.value.abs().toFixed(this.scale).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${this.isNegative() ? '-' : ''}${this.currency} ${grouped}${frac ? `.${frac}` : ''}`;
  }
}
