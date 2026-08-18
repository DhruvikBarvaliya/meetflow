/**
 * Analytics request schemas.
 *
 * Every analytics endpoint answers the same question about a different axis, so
 * they all take the same window: a pair of inclusive calendar dates plus two
 * optional narrowings. Sharing one schema is deliberate — a dashboard that
 * changes its date picker must not have to know which panel wants `from`/`to`
 * and which wants `start`/`end`.
 *
 * The window is expressed in **calendar dates, not instants**. A day is a
 * property of a clock, and the only clock that makes sense for a workspace's
 * own reporting is the workspace's: "1 March" means 1 March where the business
 * is, whatever zone the browser asking happens to sit in. The dates are
 * resolved against `businessTimezone` inside PostgreSQL, so an offset supplied
 * by the client would be a second, contradictory answer to a question that
 * already has one.
 *
 * Neither `locationId` nor `staffProfileId` is a tenant selector: both are used
 * inside a query already filtered by the caller's proven `businessId`, so an id
 * belonging to another workspace matches no rows and reports zeros — it never
 * reaches, or confirms the existence of, another tenant's data.
 */
import { z } from 'zod';
import { isIsoDate } from '../../utils/time';

const uuidSchema = z.string().uuid();

const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * The shared analytics window.
 *
 * `from` and `to` are required. An analytics view always has a visible period,
 * so demanding one costs the client nothing and stops a bare `GET /overview`
 * from aggregating a workspace's entire history. The hard cap on the width of
 * that period lives in range.ts, because the report surface enforces it too.
 */
export const analyticsRangeQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    locationId: uuidSchema.optional(),
    staffProfileId: uuidSchema.optional(),
  })
  // strict(): a stray `businessId` in the query string must be a loud 422, never
  // a silently ignored attempt to report on another tenant.
  .strict()
  // ISO dates sort lexicographically, so no parsing is needed to order them.
  .refine((query) => query.to >= query.from, {
    path: ['to'],
    message: 'The end of the range cannot precede its start.',
  });

export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeQuerySchema>;
