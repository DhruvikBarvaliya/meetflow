/**
 * Converting between what an operator types and what the API stores.
 *
 * Every money field on this API is an integer in the currency's **minor
 * units** — `350000` INR is ₹3,500.00 — but nobody prices a massage in paise.
 * Forms therefore take major units and convert at the boundary.
 *
 * The factor is asked of `Intl` rather than assumed to be 100. JPY and KRW have
 * no minor unit at all, and a hard-coded ×100 would store a Tokyo studio's
 * ¥8,000 treatment as ¥800,000.
 */

function minorUnitFactor(currency: string, locale = 'en-IN'): number {
  try {
    const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).resolvedOptions();
    return 10 ** (maximumFractionDigits ?? 2);
  } catch {
    return 100;
  }
}

/** Major units as typed (`3500.50`) to the integer the API stores. */
export function toMinorUnits(major: number, currency: string): number {
  return Math.round(major * minorUnitFactor(currency));
}

/** The stored integer back to the number a form field shows. */
export function toMajorUnits(minor: number, currency: string): number {
  const factor = minorUnitFactor(currency);
  return minor / factor;
}

/** How many decimals the input should accept, for `step` and validation. */
export function minorUnitDigits(currency: string): number {
  return Math.round(Math.log10(minorUnitFactor(currency)));
}

/** The `step` a price input should take, so a zero-decimal currency cannot get one. */
export function priceStep(currency: string): number {
  return 1 / minorUnitFactor(currency);
}
