/**
 * Workspace request schemas.
 *
 * `businessId` deliberately appears in none of them: the tenant is derived from
 * the authenticated membership, so accepting it here would create exactly the
 * client-supplied tenant id the architecture forbids.
 */
import { z } from 'zod';
import { isValidTimezone } from '../../utils/time';

const timezone = z
  .string()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

const currency = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'Must be a three-letter ISO 4217 code.')
  .transform((value) => value.toUpperCase());

export const createBusinessSchema = z
  .object({
    name: z.string().trim().min(2, 'Workspace name is required.').max(120),
    timezone,
    slug: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens only.')
      .optional(),
    description: z.string().trim().max(2000).optional(),
    industry: z.string().trim().max(80).optional(),
    currency: currency.optional(),
    locale: z.string().trim().max(20).optional(),
    websiteUrl: z.string().url().max(300).optional(),
    supportEmail: z.string().email().max(254).optional(),
    supportPhone: z.string().trim().max(30).optional(),
    createStaffProfile: z.boolean().optional(),
  })
  .strict();

export const updateBusinessSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    industry: z.string().trim().max(80).nullable().optional(),
    timezone: timezone.optional(),
    currency: currency.optional(),
    locale: z.string().trim().max(20).optional(),
    logoUrl: z.string().url().max(500).nullable().optional(),
    websiteUrl: z.string().url().max(300).nullable().optional(),
    supportEmail: z.string().email().max(254).nullable().optional(),
    supportPhone: z.string().trim().max(30).nullable().optional(),
  })
  .strict();

/**
 * Booking policy. Every field is optional so a client can PATCH one value
 * without having to echo the rest back.
 */
export const updateSettingsSchema = z
  .object({
    slotIntervalMinutes: z.number().int().min(1).max(480).optional(),
    defaultPreBufferMinutes: z.number().int().min(0).max(1440).optional(),
    defaultPostBufferMinutes: z.number().int().min(0).max(1440).optional(),
    minNoticeMinutes: z.number().int().min(0).max(525_600).optional(),
    maxHorizonDays: z.number().int().min(1).max(730).optional(),
    cancellationDeadlineMinutes: z.number().int().min(0).optional(),
    rescheduleDeadlineMinutes: z.number().int().min(0).optional(),
    allowCustomerCancel: z.boolean().optional(),
    allowCustomerReschedule: z.boolean().optional(),
    maxReschedulesPerAppointment: z.number().int().min(0).max(50).optional(),
    requireApproval: z.boolean().optional(),
    maxBookingsPerCustomerPerDay: z.number().int().min(1).nullable().optional(),
    maxBookingsPerStaffPerDay: z.number().int().min(1).nullable().optional(),
    noShowGraceMinutes: z.number().int().min(0).max(1440).optional(),
    waitlistEnabled: z.boolean().optional(),
    waitlistHoldMinutes: z.number().int().min(1).max(10_080).optional(),
    waitlistAutoBook: z.boolean().optional(),
    reminderOffsetsMinutes: z.array(z.number().int().min(1).max(43_200)).max(5).optional(),
    branding: z.record(z.unknown()).optional(),
  })
  .strict();

export const slugAvailabilitySchema = z.object({ slug: z.string().trim().min(2).max(60) }).strict();

export type CreateBusinessBody = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessBody = z.infer<typeof updateBusinessSchema>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>;
