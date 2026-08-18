/**
 * Shared plumbing for the raw-SQL reporting queries.
 *
 * Analytics is the one part of MeetFlow that reaches past Sequelize's model
 * layer, because every figure it returns is an aggregate over rows rather than
 * a row. Two consequences are handled here rather than at each call site:
 *
 *  1. **node-postgres returns `bigint` and `numeric` as strings.** `COUNT(*)`
 *     over a large table cannot fit in a double, so the driver refuses to guess;
 *     an untouched `SUM(price_amount)` would therefore be serialised into JSON
 *     as `"1250"` and quietly break arithmetic in every client. Every aggregate
 *     column is declared `Numeric` and pushed through `toNumber`.
 *  2. **Rates and averages need a fixed precision.** The division happens in
 *     SQL, over real aggregates; `round` only decides how many of the resulting
 *     digits are meaningful enough to publish.
 */

/** An aggregate column as the driver hands it over: number, string, or NULL. */
export type Numeric = string | number | null;

/**
 * Coerces an aggregate column to a number.
 *
 * NULL becomes 0 rather than null: an aggregate over no rows means "none of
 * this happened", and a client charting the series should not have to special
 * case a hole. A value that cannot be parsed at all would be a driver or query
 * bug, so it collapses to 0 too rather than poisoning the response with `NaN`
 * (which `JSON.stringify` renders as `null`).
 */
export function toNumber(value: Numeric): number {
  if (value === null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Trims a computed rate or average to a publishable number of decimals. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Rates are shares in [0, 1]; four decimals is a hundredth of a percent. */
export const RATE_DECIMALS = 4;

/** Averages are quantities (hours, minutes); two decimals is plenty. */
export const AVERAGE_DECIMALS = 2;
