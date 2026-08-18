import { z } from 'zod';

/**
 * The password rules, mirrored from `server/src/utils/password.ts`.
 *
 * Checking client-side is purely about feedback speed — the server re-validates
 * every rule and additionally rejects passwords from known breach lists, which
 * this cannot see. So a password that passes here can still be refused, and the
 * form surfaces the server's reason when that happens.
 */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 10 characters', test: (value: string) => value.length >= 10 },
  { id: 'uppercase', label: 'An uppercase letter', test: (value: string) => /[A-Z]/.test(value) },
  { id: 'lowercase', label: 'A lowercase letter', test: (value: string) => /[a-z]/.test(value) },
  { id: 'number', label: 'A number', test: (value: string) => /\d/.test(value) },
] as const;

export const passwordSchema = z
  .string()
  .min(10, 'Must be at least 10 characters.')
  .max(128, 'Must be at most 128 characters.')
  .regex(/[A-Z]/, 'Must contain an uppercase letter.')
  .regex(/[a-z]/, 'Must contain a lowercase letter.')
  .regex(/\d/, 'Must contain a number.');

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter your email address.')
  .max(254)
  .email('Enter a valid email address.');
