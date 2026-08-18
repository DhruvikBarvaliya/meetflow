/**
 * Auth request schemas.
 *
 * These are the single source of truth for the auth contract: the runtime
 * validation, the generated OpenAPI document and the frontend's generated types
 * all derive from them, so the three cannot drift apart.
 */
import { z } from 'zod';
import { PASSWORD_POLICY } from '../../utils/password';
import { isValidTimezone } from '../../utils/time';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address.');

export const passwordSchema = z
  .string()
  .min(PASSWORD_POLICY.minLength, `Must be at least ${PASSWORD_POLICY.minLength} characters.`)
  .max(PASSWORD_POLICY.maxLength);

export const timezoneSchema = z
  .string()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: z.string().trim().min(1, 'First name is required.').max(100),
    lastName: z.string().trim().min(1, 'Last name is required.').max(100),
    phone: z.string().trim().min(5).max(30).optional(),
    timezone: timezoneSchema.optional(),
  })
  // strict(): a stray `platformRole` in the body must be a loud 422, never a
  // silently ignored privilege-escalation attempt.
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required.'),
  })
  .strict();

export const refreshSchema = z
  .object({
    // Optional in the body: browser clients send it as an httpOnly cookie.
    refreshToken: z.string().min(20).optional(),
  })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) }).strict();

export const requestPasswordResetSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: passwordSchema,
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  })
  .strict();

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
