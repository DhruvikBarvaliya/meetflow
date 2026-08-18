/**
 * Password hashing and strength policy.
 *
 * bcrypt with a cost of 12: deliberately slow, salted per hash, and with no
 * native build step so the image builds identically everywhere.
 */
import bcrypt from 'bcryptjs';

const COST_FACTOR = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST_FACTOR);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that would distinguish this account from any other.
    return false;
  }
}

/** Rules mirrored by the client-side validator and the OpenAPI description. */
export const PASSWORD_POLICY = {
  minLength: 10,
  maxLength: 128,
  requiresUppercase: true,
  requiresLowercase: true,
  requiresNumber: true,
} as const;

/**
 * The 30 or so passwords that dominate every credential-stuffing list. Cheap to
 * check and blocks the worst choices without pretending to be a full corpus.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'qwerty123',
  'letmein123',
  'welcome123',
  'admin123',
  'iloveyou1',
  'sunshine1',
  'princess1',
  'football1',
  'monkey123',
  'abc123456',
  'trustno1',
  'dragon123',
  'baseball1',
  'superman1',
  'starwars1',
  'meetflow123',
  'changeme123',
  'secret123',
  'test1234',
  'temp1234',
]);

export interface PasswordCheck {
  valid: boolean;
  problems: string[];
}

export function checkPasswordStrength(password: string): PasswordCheck {
  const problems: string[] = [];

  if (password.length < PASSWORD_POLICY.minLength) {
    problems.push(`Must be at least ${PASSWORD_POLICY.minLength} characters long.`);
  }
  if (password.length > PASSWORD_POLICY.maxLength) {
    problems.push(`Must be at most ${PASSWORD_POLICY.maxLength} characters long.`);
  }
  if (PASSWORD_POLICY.requiresUppercase && !/[A-Z]/.test(password)) {
    problems.push('Must contain an uppercase letter.');
  }
  if (PASSWORD_POLICY.requiresLowercase && !/[a-z]/.test(password)) {
    problems.push('Must contain a lowercase letter.');
  }
  if (PASSWORD_POLICY.requiresNumber && !/\d/.test(password)) {
    problems.push('Must contain a number.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('This password appears in well-known breach lists. Choose another.');
  }

  return { valid: problems.length === 0, problems };
}
