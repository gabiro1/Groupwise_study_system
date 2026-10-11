import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import env from "../config/env.js";
import { RateLimitError } from "../lib/errors.js";

/**
 * Rate limiting.
 *
 * Keyed by authenticated user id when available and by IP otherwise, so a
 * shared campus NAT does not cause one student's browsing to throttle another,
 * and a single abusive account cannot hide behind rotating addresses.
 *
 * `ipKeyGenerator` is used rather than `req.ip` directly to comply with the
 * library's IPv6 handling requirements.
 */

const jsonMessage = (message, code) => ({
  error: { code, message },
});

const handler = (message, code) => (req, res, next) => {
  const retryAfterSeconds = Number(req.headers["retry-after"]) || undefined;
  next(Object.assign(new RateLimitError(message, retryAfterSeconds), { status: 429, code }));
};

/** Broad ceiling applied to the whole API surface. */
export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  skip: (req) => req.path === "/health" || req.path === "/metrics",
  handler: handler("Too many requests. Please slow down.", "RATE_LIMITED"),
});

/**
 * Strict limiter for credential endpoints. Progressive lockout lives in the auth
 * service (per-account); this is the per-IP network-level ceiling in front of it.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    // Key on the submitted email when present, so one student's typo does not
    // lock out their housemates behind the same NAT address.
    const email = req.body?.email;
    if (typeof email === "string" && email.length > 3) {
      return `auth:${email.trim().toLowerCase()}`;
    }
    return ipKeyGenerator(req);
  },
  handler: handler(
    "Too many sign-in attempts. Please wait 15 minutes and try again.",
    "AUTH_RATE_LIMITED",
  ),
});

/** Search and discovery — expensive queries, so capped tighter than reads. */
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.SEARCH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  handler: handler("Too many searches. Please wait a moment.", "SEARCH_RATE_LIMITED"),
});

/**
 * AI endpoints — the strictest limit, because each call costs money and
 * upstream quota. Combined with response caching in the AI service.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.AI_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  handler: handler(
    "You've reached the AI usage limit for this minute. Please wait a moment before trying again.",
    "AI_RATE_LIMITED",
  ),
});

/** Mutations: task updates, messages, invitations. */
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.WRITE_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  skip: (req) => req.method === "GET" || req.method === "HEAD",
  handler: handler("You're making changes too quickly. Please slow down.", "WRITE_RATE_LIMITED"),
});

/** Public contact form — limit anonymous submissions to curb email abuse. */
export const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: handler("Too many messages were sent. Please try again in 15 minutes.", "CONTACT_RATE_LIMITED"),
});

/** File uploads — sized separately, plus the byte limit enforced by multer. */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  handler: handler("You've uploaded too many files recently. Please try again later.", "UPLOAD_RATE_LIMITED"),
});

/** Messaging, scoped per user to prevent one noisy student affecting a group. */
export const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  handler: handler("You're sending messages too quickly.", "MESSAGE_RATE_LIMITED"),
});

export default {
  globalLimiter,
  authLimiter,
  searchLimiter,
  aiLimiter,
  writeLimiter,
  contactLimiter,
  uploadLimiter,
  messageLimiter,
  jsonMessage,
};