import { describe, expect, it } from 'vitest';
import {
  addMonths,
  allocateWhole,
  ceilingRoom,
  grossReduction,
  maskPhone,
  maxRedeemablePoints,
  monthlyCashback,
  parseMemberQr,
  pointsEarned,
  resolveClubRates,
  returnEffect,
} from './loyalty';

describe('points earning and redemption (LOY01, LOY12, LOY13)', () => {
  it('LAT01: KES 5,000 eligible earns 50 points; fractions round down once', () => {
    expect(pointsEarned('5000.00', '100.00')).toBe(50);
    expect(pointsEarned('4299.99', '100.00')).toBe(42);
    expect(pointsEarned('0.00', '100.00')).toBe(0);
  });

  it('LAT02: 800 points on a KES 5,000 bill leaves KES 4,200 that earns 42', () => {
    const redeem = maxRedeemablePoints({ eligible: '5000.00', capPercent: '20', pointValue: '1.00', available: 800, minRedeem: 100 });
    expect(redeem).toBe(800);
    expect(pointsEarned('4200.00', '100.00')).toBe(42);
    // Cap: 20% of 5,000 is 1,000 even with more points available.
    expect(maxRedeemablePoints({ eligible: '5000.00', capPercent: '20', pointValue: '1.00', available: 5000, minRedeem: 100 })).toBe(1000);
    expect(maxRedeemablePoints({ eligible: '400.00', capPercent: '20', pointValue: '1.00', available: 800, minRedeem: 100 })).toBe(0);
  });

  it('allocates redeemed points to lines exactly (worked partial refund: 480 and 320)', () => {
    expect(allocateWhole(800, ['3000.00', '2000.00'])).toEqual([480, 320]);
    expect(allocateWhole(100, ['1', '1', '1'])).toEqual([34, 33, 33]);
    expect(allocateWhole(5, ['0', '0'])).toEqual([0, 0]);
  });

  it('a reward lowers the taxable value: KES 800 off a 5,000 net line is 944 off the 18%-inclusive price', () => {
    expect(grossReduction('800.00', '5900.00', '5000.00', 'net')).toBe('944.00');
    expect(grossReduction('480.00', '3540.00', '3000.00', 'net')).toBe('566.40');
    expect(grossReduction('800.00', '5900.00', '5900.00', 'gross')).toBe('800.00');
  });

  it('LAT05 partial: returning the KES 2,000 item restores 320, reverses 17 and leaves 345', () => {
    const lines = [
      { eligibleBefore: '3000.00', points: 480, wallet: '0.00', keptFraction: '1', returnedFraction: '0' },
      { eligibleBefore: '2000.00', points: 320, wallet: '0.00', keptFraction: '0', returnedFraction: '1' },
    ];
    const r = returnEffect(lines, 42, '100.00');
    expect(r.restorePoints).toBe(320);
    expect(r.retainedEligible).toBe('2520.00');
    expect(r.reversePoints).toBe(17);
    expect(42 - r.reversePoints + r.restorePoints).toBe(345);
  });

  it('LAT05 full: a full return restores 800 and reverses all 42', () => {
    const lines = [
      { eligibleBefore: '3000.00', points: 480, wallet: '0.00', keptFraction: '0', returnedFraction: '1' },
      { eligibleBefore: '2000.00', points: 320, wallet: '0.00', keptFraction: '0', returnedFraction: '1' },
    ];
    expect(returnEffect(lines, 42, '100.00')).toEqual({ restorePoints: 800, restoreWallet: '0.00', retainedEligible: '0.00', reversePoints: 42 });
  });
});

describe('club rates and monthly cashback (CLUB01, CLUB03, CAT01–CAT09)', () => {
  const programme = { discountPercent: '10', cashbackPercent: '15' };

  it('CAT04: an individual override beats the tier, which beats the programme', () => {
    expect(resolveClubRates({ discountPercent: '12', cashbackPercent: null }, { discountPercent: '10', cashbackPercent: null }, programme)).toEqual({
      discountPercent: '12',
      cashbackPercent: '15',
      source: { discount: 'override', cashback: 'programme' },
    });
    expect(resolveClubRates(null, { discountPercent: '10', cashbackPercent: '12' }, programme).source).toEqual({ discount: 'tier', cashback: 'tier' });
  });

  it('CAT01: KES 50,000 at 10% is 5,000; at 15% is 7,500', () => {
    expect(monthlyCashback([{ eligible: '50000.00', ratePercent: '10' }], '0', null).credit).toBe('5000.00');
    expect(monthlyCashback([{ eligible: '50000.00', ratePercent: '15' }], '0', null).credit).toBe('7500.00');
  });

  it('CAT02: KES 10,000 less 10% leaves 9,000; 15% cashback is 1,350', () => {
    expect(monthlyCashback([{ eligible: '9000.00', ratePercent: '15' }], '0', null).credit).toBe('1350.00');
  });

  it('CAT03: 20,000 at 10% then 30,000 at 15% credits 6,500', () => {
    expect(
      monthlyCashback(
        [
          { eligible: '20000.00', ratePercent: '10' },
          { eligible: '30000.00', ratePercent: '15' },
        ],
        '0',
        null,
      ).credit,
    ).toBe('6500.00');
  });

  it('rounds the month once, not every sale', () => {
    const items = Array.from({ length: 3 }, () => ({ eligible: '0.05', ratePercent: '10' }));
    expect(monthlyCashback(items, '0', null).credit).toBe('0.02'); // 0.015 → 0.02, not 3 × 0.01
  });

  it('CAT07: a KES 10,000 return takes KES 1,000 off a 5,000 credit', () => {
    expect(
      monthlyCashback(
        [
          { eligible: '50000.00', ratePercent: '10' },
          { eligible: '-10000.00', ratePercent: '10' },
        ],
        '0',
        null,
      ).credit,
    ).toBe('4000.00');
  });

  it('CAT09: KES 20,000 minimum and KES 3,000 cap', () => {
    expect(monthlyCashback([{ eligible: '15000.00', ratePercent: '10' }], '20000', '3000').credit).toBe('0.00');
    expect(monthlyCashback([{ eligible: '50000.00', ratePercent: '10' }], '20000', '3000')).toMatchObject({ credit: '3000.00', capped: true });
    // A return that drops the month below the minimum removes the credit.
    expect(
      monthlyCashback(
        [
          { eligible: '50000.00', ratePercent: '10' },
          { eligible: '-35000.00', ratePercent: '10' },
        ],
        '20000',
        '3000',
      ).credit,
    ).toBe('0.00');
  });
});

describe('benefit ceiling and helpers (LOY26, LAT16)', () => {
  it('LAT16: on a KES 10,000 bill with a 25% ceiling, benefits stop at 2,500', () => {
    expect(ceilingRoom('10000.00', '25', '1000.00')).toBe('1500.00');
    expect(ceilingRoom('10000.00', '25', '3000.00')).toBe('0.00');
  });

  it('adds months and clamps to the month end', () => {
    expect(addMonths('2026-10-30', 12)).toBe('2027-10-30');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
  });

  it('reads member card QR codes and masks phones for POS staff', () => {
    expect(parseMemberQr('YS:YS100001:abcdefghijklmnop1234')).toEqual({ number: 'YS100001', token: 'abcdefghijklmnop1234' });
    expect(parseMemberQr('+254700000000')).toBeNull();
    expect(maskPhone('+254 712 345 678')).toBe('••• 678');
  });
});
