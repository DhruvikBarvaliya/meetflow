/**
 * Report request schemas.
 *
 * The tabular report and its CSV export take exactly the same filters, and take
 * them from one schema on purpose: an export that could not reproduce the table
 * an operator was looking at would be worse than no export at all.
 *
 * `from`/`to` are optional here, unlike on the analytics surface. A report is a
 * record-keeping tool — "every appointment this customer's branch has ever had"
 * is a legitimate question — and the two bounds that make it safe to ask are the
 * page size on the JSON route and the hard row cap on the CSV one. When both
 * dates *are* supplied, the same 366-day cap the analytics surface uses applies,
 * so a range filter cannot be used to force an unindexed scan.
 */
import { z } from 'zod';
import { APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import { isIsoDate } from '../../utils/time';

const uuidSchema = z.string().uuid();

const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * `?status=CONFIRMED&status=PENDING` arrives as an array, a lone `?status=X` as
 * a bare string. Both normalise to an array so the query layer has one shape.
 */
const statusQuery = z
  .union([
    z.enum(APPOINTMENT_STATUSES),
    z.array(z.enum(APPOINTMENT_STATUSES)).min(1).max(APPOINTMENT_STATUSES.length),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const filterShape = {
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  status: statusQuery.optional(),
  serviceId: uuidSchema.optional(),
  staffProfileId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
};

/** Shared by both routes so the export cannot drift from the table. */
const rangeOrder = (query: { from?: string; to?: string }): boolean =>
  query.from === undefined || query.to === undefined || query.to >= query.from;

const RANGE_ORDER_MESSAGE = {
  path: ['to'],
  message: 'The end of the range cannot precede its start.',
};

export const appointmentReportQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    ...filterShape,
  })
  // strict(): a stray `businessId` in the query string must be a loud 422, never
  // a silently ignored attempt to report on another tenant.
  .strict()
  .refine(rangeOrder, RANGE_ORDER_MESSAGE);

/**
 * The export takes no pagination: it is bounded by the row cap in
 * reports.service.ts, and a page number would only produce a truncated file
 * that looks complete.
 */
export const appointmentExportQuerySchema = z
  .object(filterShape)
  .strict()
  .refine(rangeOrder, RANGE_ORDER_MESSAGE);

export type AppointmentReportQuery = z.infer<typeof appointmentReportQuerySchema>;
export type AppointmentExportQuery = z.infer<typeof appointmentExportQuerySchema>;
