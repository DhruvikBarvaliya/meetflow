/**
 * The form boundary between what an operator types and what the API stores.
 *
 * A defect here is a wrong price in the database, not a wrong price on screen —
 * the operator types 3500, sees 3500 echoed back by their own input, and the
 * booking page charges something else. It survives a round trip too, because
 * the same wrong factor converts back.
 */
import { describe, expect, it } from 'vitest';
import { minorUnitDigits, priceStep, toMajorUnits, toMinorUnits } from './money';

describe('toMinorUnits', () => {
  it('converts a typed price to the integer the API stores', () => {
    expect(toMinorUnits(3_500, 'INR')).toBe(350_000);
    expect(toMinorUnits(3_500.5, 'INR')).toBe(350_050);
  });

  it('leaves a zero-decimal currency alone', () => {
    // ×100 here stores a Tokyo studio's ¥8,000 treatment as ¥800,000 and the
    // customer is billed a hundredfold.
    expect(toMinorUnits(8_000, 'JPY')).toBe(8_000);
    expect(toMinorUnits(8_000, 'KRW')).toBe(8_000);
  });

  it('rounds rather than truncating floating-point drift', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754 and 0.29 * 100 is
    // 28.999999999999996. Truncating either — which is what `| 0` or
    // `Math.floor` would do — stores a price one minor unit short, on a value
    // the operator typed exactly.
    expect(toMinorUnits(19.99, 'INR')).toBe(1_999);
    expect(toMinorUnits(0.29, 'USD')).toBe(29);
    expect(toMinorUnits(0.615, 'USD')).toBe(62);
  });

  it('falls back to two decimals for a currency Intl does not know', () => {
    expect(toMinorUnits(35, 'ZZZ')).toBe(3_500);
  });
});

describe('toMajorUnits', () => {
  it('round-trips a stored amount back into the form field', () => {
    expect(toMajorUnits(350_000, 'INR')).toBe(3_500);
    expect(toMajorUnits(350_050, 'INR')).toBe(3_500.5);
    expect(toMajorUnits(8_000, 'JPY')).toBe(8_000);
  });

  it('survives the round trip in both directions', () => {
    for (const [major, currency] of [
      [3_500.5, 'INR'],
      [8_000, 'JPY'],
      [19.99, 'USD'],
    ] as const) {
      expect(toMajorUnits(toMinorUnits(major, currency), currency)).toBe(major);
    }
  });
});

describe('minorUnitDigits and priceStep', () => {
  it('lets a two-decimal currency accept paise', () => {
    expect(minorUnitDigits('INR')).toBe(2);
    expect(priceStep('INR')).toBe(0.01);
  });

  it('refuses a zero-decimal currency a fractional step', () => {
    // A `step` of 0.01 on a JPY field invites a price the currency cannot
    // express, which then rounds away on save without telling anyone.
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(priceStep('JPY')).toBe(1);
  });
});
