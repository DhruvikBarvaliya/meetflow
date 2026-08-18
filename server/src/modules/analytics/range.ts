/**
 * The bound on how much history one reporting request may touch.
 *
 * Every analytics query aggregates over the appointment table, and an
 * unbounded window is the difference between an indexed range scan and a scan
 * of a workspace's entire history — repeated seven times by a dashboard that
 * loads seven panels at once. A year and a day covers every "compare with the
 * same period last year" view, which is the widest thing the product asks for.
 *
 * The cap is enforced here rather than in the zod schema because it is a domain
 * rule shared by the analytics and the report surfaces, and because the caller
 * deserves to be told how wide their window actually was.
 */
import { ValidationError } from '../../utils/errors';
import { type IsoDate, daysBetween } from '../../utils/time';

export const MAX_RANGE_DAYS = 366;

/**
 * Rejects a window that is inverted or wider than the cap.
 *
 * Both bounds are inclusive calendar dates, so a single day is a span of one.
 */
export function assertRangeWithinCap(from: IsoDate, to: IsoDate): void {
  const spanDays = daysBetween(from, to) + 1;

  if (spanDays < 1) {
    throw new ValidationError('The end of the reporting window cannot precede its start.', [
      { field: 'to', message: `Must be on or after ${from}.` },
    ]);
  }

  if (spanDays > MAX_RANGE_DAYS) {
    throw new ValidationError(`A reporting window may span at most ${MAX_RANGE_DAYS} days.`, [
      { field: 'to', message: `The requested window covers ${spanDays} days.` },
    ]);
  }
}
