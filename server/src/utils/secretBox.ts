/**
 * Encrypting the one secret MeetFlow stores that it has to be able to read back.
 *
 * Passwords are hashed and refresh tokens are stored as digests, because
 * nothing ever needs the original. A webhook signing secret is different: every
 * delivery has to compute an HMAC with it, so it must come back out of the
 * database in one piece. Hashing is not an option, and leaving it in plaintext
 * means a leaked backup, a read-only SQL injection, or anybody with database
 * access can forge deliveries that a tenant's server will accept as genuine —
 * which is the entire point of signing them.
 *
 * So: AES-256-GCM, with a key that lives in the environment rather than in the
 * database. That is a real and specific improvement, and it is worth being
 * precise about what it does and does not buy:
 *
 *  - **It defends against the database alone being lost.** A stolen dump, a
 *    snapshot on the wrong bucket, a support engineer with a psql prompt: none
 *    of those yield a usable secret without the key, which is not in there.
 *  - **It does not defend against the host being compromised.** Anything that
 *    can read the process environment can decrypt. Moving the key to a KMS with
 *    per-request unwrapping is the next step and is recorded as such in
 *    `docs/SecurityThreatModel.md`; this is not that, and does not claim to be.
 *
 * GCM rather than CBC because the tag authenticates the ciphertext: a row
 * somebody edited in the database fails to open rather than decrypting to
 * something else. The endpoint id is bound in as additional authenticated data,
 * so a ciphertext copied from one row to another is refused too — otherwise
 * anybody with write access could give their own endpoint a neighbour's secret
 * and then read it back through the create response of their own.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('secret-box');

/**
 * The version tag, and the reason there is one.
 *
 * A stored value with no recognised prefix is treated as plaintext written
 * before this existed, and returned as-is. That is what makes turning
 * encryption on a deployment step rather than a migration with downtime:
 * existing endpoints keep signing correctly, and each is re-sealed the next
 * time its row is written. A future key rotation adds `v2.` beside this rather
 * than changing what `v1.` means.
 */
const PREFIX = 'v1.';

/**
 * Derives the 32-byte key from whatever length the operator configured.
 *
 * SHA-256 over the configured value, so a 40-character passphrase and a
 * 64-character hex string both work and neither is silently truncated. It is
 * not a password-based KDF because the input is a machine-generated secret from
 * the environment, not something a human chose — iterating over it would cost
 * startup time to defend against a brute force that is not the threat here.
 */
function keyOf(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

let warned = false;

/** The configured key, or null when encryption is off. */
function activeKey(): Buffer | null {
  const configured = env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!configured) {
    // Once per process, not per row: a warning on every write is a warning
    // nobody reads. `env.ts` refuses to start in production without a key, so
    // this only ever fires locally.
    if (!warned) {
      warned = true;
      log.warn(
        'WEBHOOK_SECRET_ENCRYPTION_KEY is not set — webhook signing secrets are stored in plaintext. This is refused in production.',
      );
    }
    return null;
  }
  return keyOf(configured);
}

/**
 * Encrypts a secret for storage. Returns it unchanged when no key is configured.
 *
 * `aad` binds the ciphertext to the row it belongs to.
 */
export function sealSecret(plaintext: string, aad: string): string {
  const key = activeKey();
  if (!key) return plaintext;

  const iv = randomBytes(12); // 96 bits, the size GCM is defined for
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

/**
 * Reads a stored secret back.
 *
 * Three cases, and the middle one is the reason this cannot simply throw on
 * anything unexpected:
 *
 *  - Sealed and openable: the plaintext.
 *  - **No prefix**: a row written before encryption was turned on. Returned
 *    unchanged, so enabling the key does not break every endpoint that already
 *    exists.
 *  - Sealed and *not* openable: the wrong key, or a tampered row. This throws,
 *    because delivering with a silently wrong secret would produce signatures
 *    the recipient rejects, and the resulting support thread ("deliveries
 *    started failing, nothing changed") is far worse than a loud error naming
 *    the endpoint.
 */
export function openSecret(stored: string, aad: string): string {
  if (!stored.startsWith(PREFIX)) return stored;

  const key = activeKey();
  if (!key) {
    throw new Error(
      'A webhook signing secret is encrypted but WEBHOOK_SECRET_ENCRYPTION_KEY is not set.',
    );
  }

  const [ivPart, tagPart, ciphertextPart] = stored.slice(PREFIX.length).split('.');
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error('A webhook signing secret is stored in a shape this version cannot read.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
