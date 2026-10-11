import bcrypt from "bcryptjs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Password and token cryptography.
 *
 * Design notes:
 *  - Passwords are hashed with bcrypt at cost 12 (≈250ms on commodity
 *    hardware). Argon2id would be preferable, but bcryptjs is pure JS and
 *    therefore portable across environments without a native build step; the
 *    cost factor is the parameter that matters most and is raised here rather
 *    than left at the library default of 10.
 *  - Tokens that get emailed (verification, reset) are random 256-bit values.
 *    Only a SHA-256 hash of them is stored, so a database compromise does not
 *    yield usable tokens.
 *  - Token comparison is constant-time, so verification is not vulnerable to
 *    timing analysis.
 */

const BCRYPT_COST = 12;
const BCRYPT_ROUNDS = 12;

/** @returns {Promise<string>} the hash to persist. */
export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Constant-time-ish verification. bcrypt.compare is constant-time for the
 * hash itself; a dummy hash is used when the user does not exist so that a
 * missing account and a wrong password take the same time to reject.
 */
const DUMMY_HASH = bcrypt.hashSync("lien::timing::equaliser", BCRYPT_ROUNDS);

export async function verifyPassword(plaintext, hash) {
  if (!hash) return bcrypt.compare(plaintext, DUMMY_HASH);
  return bcrypt.compare(plaintext, hash);
}

/**
 * @returns {string} URL-safe random token, e.g. for an email link.
 */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** Deterministic, non-reversible storage form of a token. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Length-safe constant-time string comparison for opaque tokens. */
export function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so length is the only leak, not content.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Progressive lockout policy.
 *
 * After `threshold` consecutive failures the account is locked for
 * `lockoutMinutes`. The delay grows with each subsequent failure so that a
 * distributed guessing attack is progressively expensive, while a legitimate
 * user who mistypes twice is never locked out.
 */
export const LOCKOUT_POLICY = Object.freeze({
  threshold: 5,
  lockoutMinutes: [1, 5, 15, 60],
  resetAfterMinutes: 30,
});

/**
 * @param {number} failedCount Consecutive failed attempts.
 * @returns {{locked:boolean, until: Date|null, minutes: number}}
 */
export function evaluateLockout(failedCount, now = new Date()) {
  if (failedCount < LOCKOUT_POLICY.threshold) {
    return { locked: false, until: null, minutes: 0 };
  }
  const overBy = failedCount - LOCKOUT_POLICY.threshold;
  const index = Math.min(overBy, LOCKOUT_POLICY.lockoutMinutes.length - 1);
  const minutes = LOCKOUT_POLICY.lockoutMinutes[index];
  const until = new Date(now.getTime() + minutes * 60_000);
  return { locked: true, until, minutes };
}

/** Reset the failure counter once the window has elapsed. */
export function shouldResetFailureCount(lastFailedAt, now = new Date()) {
  if (!lastFailedAt) return false;
  const elapsedMs = now.getTime() - new Date(lastFailedAt).getTime();
  return elapsedMs > LOCKOUT_POLICY.resetAfterMinutes * 60_000;
}

export default {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  safeCompare,
  evaluateLockout,
  shouldResetFailureCount,
  LOCKOUT_POLICY,
};