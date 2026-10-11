import jwt from "jsonwebtoken";
import env from "../config/env.js";
import { AuthenticationError, SessionExpiredError } from "./errors.js";
import { generateToken, hashToken } from "./crypto.js";

/**
 * Token strategy.
 *
 * Access tokens are short-lived (15 min) stateless JWTs so that the vast
 * majority of requests need no database round trip. Refresh tokens are opaque
 * 256-bit random values stored *hashed* in `auth_sessions`, which gives three
 * things JWTs alone cannot:
 *
 *   1. Server-side revocation — "log out everywhere" actually works.
 *   2. Per-session device metadata for a "your devices" screen.
 *   3. No bearer-token replay if the database is ever exposed.
 */

export const ACCESS_TOKEN_TYPE = "access";
export const REFRESH_TOKEN_TYPE = "refresh";

/**
 * @param {object} payload
 * @returns {string} signed JWT.
 */
export function signAccessToken({ userId, role, roleId, sessionId, email, name }) {
  return jwt.sign(
    {
      sub: userId,
      role,
      rid: roleId,
      sid: sessionId,
      email,
      name,
      typ: ACCESS_TOKEN_TYPE,
    },
    env.AUTH_SECRET,
    {
      expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
      issuer: env.APP_NAME,
      audience: "lien-api",
      algorithm: "HS256",
    },
  );
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.AUTH_SECRET, {
      issuer: env.APP_NAME,
      audience: "lien-api",
      algorithms: ["HS256"], // pinned: prevents algorithm-confusion attacks
    });
    if (payload.typ !== ACCESS_TOKEN_TYPE) throw new Error("wrong token type");
    return payload;
  } catch (error) {
    if (error.name === "TokenExpiredError") throw new SessionExpiredError();
    throw new AuthenticationError();
  }
}

/** Opaque refresh token plus the hash to persist. */
export function createRefreshToken() {
  const token = generateToken(48);
  return { token, hash: hashToken(token) };
}

export function hashRefreshToken(token) {
  return hashToken(token);
}

/** Absolute expiry for a new refresh session. */
export function refreshTokenExpiry() {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Minimal cookie attributes, applied consistently by the auth routes. */
export function cookieOptions({ maxAgeMs } = {}) {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAME_SITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/",
    ...(maxAgeMs ? { maxAge: Math.floor(maxAgeMs) } : {}),
  };
}

export const REFRESH_COOKIE_NAME = "lien_refresh";
export const ACCESS_COOKIE_NAME = "lien_access";

export default {
  signAccessToken,
  verifyAccessToken,
  createRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  cookieOptions,
  ACCESS_TOKEN_TYPE,
  REFRESH_TOKEN_TYPE,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_NAME,
};