import env from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { generateToken, hashToken, safeCompare } from "../lib/crypto.js";

/**
 * CSRF protection via the double-submit cookie pattern.
 *
 * Adopted because the deployment topology is a same-origin BFF: the Next.js
 * server calls this API server-side and forwards the browser's cookies, so a
 * cookie-based session would otherwise be vulnerable to cross-site POSTs.
 *
 * How it works:
 *   1. A CSRF cookie is issued to the browser (JS-readable, by necessity).
 *   2. Every mutating request must echo it in an `x-csrf-token` header.
 *   3. A cross-origin attacker can force the browser to *send* the cookie but
 *      cannot *read* it to set the header, so they cannot forge the pair.
 *
 * Requests carrying a valid `Authorization: Bearer` header are exempt: bearer
 * tokens are not attached automatically by the browser, so they are not
 * vulnerable to CSRF in the first place.
 */

const CSRF_COOKIE = "lien_csrf";
const CSRF_HEADER = "x-csrf-token";

// Safe methods never change state and therefore need no token.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Thrown as an `AppError` so the terminal handler emits 403 with a stable code.
 * A plain `Error` here would fall through to the generic 500 branch and turn a
 * client-fixable problem into an apparent server outage.
 */
class CsrfError extends AppError {
  constructor(code) {
    super("Your session could not be verified. Please refresh the page and try again.", {
      status: 403,
      code,
    });
  }
}

/** Issue a fresh CSRF token and return it along with its storage hash. */
export function issueCsrfToken() {
  const token = generateToken(24);
  return { token, hash: hashToken(token) };
}

function cookieOptions() {
  return {
    httpOnly: false, // the client must read this to echo it back
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAME_SITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/",
  };
}

export function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE, token, { ...cookieOptions(), maxAge: 12 * 60 * 60 * 1000 });
  return token;
}

/**
 * Ensure a browser holds a CSRF cookie, and hand the caller the raw token.
 *
 * This is the bootstrap that makes unauthenticated POSTs possible: signing in and
 * registering are themselves mutations, so there is no session to piggyback on.
 * Issuing the token on a safe request gives the client something to read before
 * it ever submits a form.
 */
export function ensureCsrfToken(req, res) {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing) return existing;
  return setCsrfCookie(res, issueCsrfToken().token);
}

/**
 * Middleware that enforces the double-submit check.
 * Attach after cookie parsing. Stateless bearer-token clients are exempt.
 */
export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    // Opportunistically top up the cookie so a first-time visitor is ready to
    // submit a form after any GET, including a page-data fetch.
    if (!req.cookies?.[CSRF_COOKIE]) {
      req.csrfToken = setCsrfCookie(res, issueCsrfToken().token);
    } else {
      req.csrfToken = req.cookies[CSRF_COOKIE];
    }
    return next();
  }

  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken) return next(new CsrfError("CSRF_TOKEN_MISSING"));

  // Constant-time compare of the hashed forms.
  if (!safeCompare(hashToken(cookieToken), hashToken(headerToken))) {
    return next(new CsrfError("CSRF_TOKEN_INVALID"));
  }

  return next();
}

/**
 * Rotate the CSRF cookie after a session change.
 *
 * Rotation on privilege change defeats session fixation: a token an attacker
 * planted before sign-in is not the token the authenticated session uses
 * afterwards.
 */
export function refreshCsrfCookie(res) {
  return setCsrfCookie(res, issueCsrfToken().token);
}

export function clearCsrfCookie(res) {
  res.clearCookie(CSRF_COOKIE, cookieOptions());
}

export const csrfConfig = { CSRF_COOKIE, CSRF_HEADER };

export default {
  csrfProtection,
  issueCsrfToken,
  setCsrfCookie,
  ensureCsrfToken,
  refreshCsrfCookie,
  clearCsrfCookie,
  csrfConfig,
};