/**
 * Audit-read request schemas.
 *
 * The contract for `/api/v1/audit-logs`: runtime validation, the generated
 * OpenAPI document and the frontend's types all derive from these, so the three
 * cannot drift apart.
 *
 * `businessId` appears in none of them, and never will. admin.validation.ts
 * accepts one because a platform operator holds no membership to prove a tenant
 * with; here the tenant is resolved from the caller's membership, so a workspace
 * id in the query string could only ever be an attempt to read somebody else's
 * trail. `.strict()` turns that into a loud 422 rather than a silently ignored
 * field.
 */
import { z } from 'zod';
import { isIsoDate } from '../../utils/time';

const uuidSchema = z.string().uuid();

/**
 * Range bounds are calendar dates, not instants: the query layer cuts them into
 * whole days on the workspace's own clock, so a caller never has to work out
 * which UTC moment their Tuesday began at. `to` is inclusive here and becomes a
 * half-open upper bound in the SQL.
 */
const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * Every way an entry may be narrowed, shared by the JSON list and the CSV
 * export so a download cannot describe a different set of rows from the screen
 * it was launched from.
 */
const filterShape = {
  /** Exact match on the dotted verb, e.g. `appointment.cancelled`. */
  action: z.string().trim().min(1).max(120).optional(),
  entityType: z.string().trim().min(1).max(120).optional(),
  /**
   * The audited row itself — "everything that has ever happened to this
   * booking". A UUID because `audit_logs.entity_id` is one; the column is
   * polymorphic across every audited table and carries no foreign key.
   */
  entityId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** Free text over the actor snapshot, the action and the entity type. */
  search: z.string().trim().min(1).max(120).optional(),
};

// ISO dates sort lexicographically, so no parsing is needed to order them.
const rangeOrder = (query: { from?: string; to?: string }): boolean =>
  query.from === undefined || query.to === undefined || query.to >= query.from;

const RANGE_ORDER_MESSAGE = {
  path: ['to'],
  message: 'The end of the range cannot precede its start.',
};

/**
 * `pageSize` is capped at 100, as on every other list in the product. The trail
 * is the fastest-growing table in the schema, so an uncapped page would turn a
 * read endpoint into an unbounded export with no row limit in front of it.
 */
export const listAuditEntriesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    ...filterShape,
  })
  .strict()
  .refine(rangeOrder, RANGE_ORDER_MESSAGE);

export const auditEntryIdParamsSchema = z.object({ id: uuidSchema }).strict();

/**
 * The export takes no pagination: it is bounded by the row cap in audit.query.ts,
 * and a page number would only produce a truncated file that looks complete.
 */
export const exportAuditEntriesQuerySchema = z
  .object(filterShape)
  .strict()
  .refine(rangeOrder, RANGE_ORDER_MESSAGE);

export type ListAuditEntriesQuery = z.infer<typeof listAuditEntriesQuerySchema>;
export type ExportAuditEntriesQuery = z.infer<typeof exportAuditEntriesQuerySchema>;
export type AuditEntryIdParams = z.infer<typeof auditEntryIdParamsSchema>;
