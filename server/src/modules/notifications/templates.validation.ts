/**
 * Request schemas for `/api/v1/notification-templates`.
 *
 * The contract for the surface that lets a workspace rewrite the messages its
 * customers receive. Runtime validation, the generated OpenAPI document and the
 * client's types all derive from these.
 *
 * `businessId` appears in none of them and never will: the tenant comes from
 * the caller's membership, so accepting one here would be an authorisation hole
 * with a validation schema in front of it.
 *
 * The placeholder check is *not* here. Zod can see the string; it cannot see
 * which template key the route is addressing, and "is `{{reason}}` allowed"
 * only has an answer once both are known. Doing it in the service also means
 * the refusal can name the placeholder and list the alternatives, which a
 * schema-level `refine` cannot.
 */
import { z } from 'zod';
import {
  NOTIFICATION_TEMPLATE_CHANNELS,
  NOTIFICATION_TEMPLATE_KEYS,
} from '../../database/models/NotificationTemplate';

/**
 * The address of one template.
 *
 * Key and channel together, because a workspace may well rewrite the email
 * confirmation and leave the SMS one alone — and because the table's unique
 * index is on (business, key, channel, locale), so anything narrower would not
 * identify a row.
 */
export const templateParamsSchema = z.object({
  key: z.enum(NOTIFICATION_TEMPLATE_KEYS),
  channel: z.enum(NOTIFICATION_TEMPLATE_CHANNELS),
});

export const listTemplatesQuerySchema = z.object({
  /** Restricts the listing to one channel. Absent means every channel. */
  channel: z.enum(NOTIFICATION_TEMPLATE_CHANNELS).optional(),
});

/**
 * A workspace's replacement for one message.
 *
 * `subject` is optional because SMS and in-app messages have no subject line;
 * the service refuses an email without one rather than sending mail with a
 * blank subject, which every spam filter reads exactly as it looks.
 *
 * There is no `bodyHtml`. The HTML part is generated from `bodyText` by
 * `textToHtml`, which escapes the interpolated values — letting a workspace
 * supply raw HTML would put unescaped, tenant-authored markup into an email
 * that MeetFlow's own domain is signing.
 */
export const upsertTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  bodyText: z.string().trim().min(1).max(20_000),
  /**
   * Off keeps the row but stops it shadowing the default, which is how an
   * operator parks a draft without losing it. Deleting the override is the
   * other way, and the one that leaves nothing behind.
   */
  isActive: z.boolean().optional(),
});

/**
 * A draft rendered against sample data, before anybody is sent it.
 *
 * Takes the body in the request rather than reading the saved row on purpose:
 * the whole point is to see the draft on screen *before* saving it.
 */
export const previewTemplateSchema = z.object({
  subject: z.string().trim().max(300).optional(),
  bodyText: z.string().trim().min(1).max(20_000),
});

export type TemplateParams = z.infer<typeof templateParamsSchema>;
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;
export type UpsertTemplateBody = z.infer<typeof upsertTemplateSchema>;
export type PreviewTemplateBody = z.infer<typeof previewTemplateSchema>;
