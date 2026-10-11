import { randomUUID } from "node:crypto";
import logger from "../config/logger.js";
import { AppError } from "../lib/errors.js";
import env from "../config/env.js";

/**
 * Request context: correlation id and structured access logging.
 *
 * Every response carries an `x-request-id`. Clients surface it in error
 * reports, so a user reporting "something broke" can be traced to the exact
 * log lines without guessing from a timestamp.
 */
export function requestContext(req, res, next) {
  // Honour an upstream id when the request came through the BFF, so a single
  // trace spans both tiers.
  const inbound = req.get("x-request-id");
  const requestId = inbound && /^[\w-]{1,64}$/.test(inbound) ? inbound : randomUUID();

  req.requestId = requestId;
  req.startedAt = process.hrtime.bigint();
  res.setHeader("x-request-id", requestId);

  // Never let the URL become an injection vector for log lines.
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    logger[level]("request", {
      requestId,
      method: req.method,
      // req.originalUrl is attacker-controlled; truncate to keep logs bounded.
      path: (req.originalUrl || req.url).slice(0, 300),
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      userId: req.user?.id,
      role: req.user?.role,
      // Only the route pattern, never query values which may hold search terms.
      route: req.route?.path,
    });
  });

  next();
}

/**
 * Terminal error handler.
 *
 * Two audiences, two levels of detail:
 *  - The client receives a stable code, a human-readable sentence, and field
 *    errors for form binding. Never a stack trace, SQL fragment or driver name.
 *  - The log receives everything, correlated by request id.
 */
export function errorHandler(error, req, res, _next) {
  const requestId = req.requestId;

  // Express body-parser failures arrive as plain errors with a status.
  if (error?.type === "entity.parse.failed") {
    return respond(res, requestId, 400, "BAD_JSON", "The request body was not valid JSON.");
  }
  if (error?.type === "entity.too.large") {
    return respond(res, requestId, 413, "PAYLOAD_TOO_LARGE", "The request was too large.");
  }

  // Multer surfaces upload problems with a `code` rather than a status.
  if (error?.code === "LIMIT_FILE_SIZE") {
    return respond(
      res,
      requestId,
      413,
      "PAYLOAD_TOO_LARGE",
      `That file is larger than the ${Math.round(env.UPLOAD_MAX_BYTES / 1024 / 1024)} MB limit.`,
    );
  }
  if (typeof error?.code === "string" && error.code.startsWith("LIMIT_")) {
    return respond(res, requestId, 413, "UPLOAD_REJECTED", "That upload was rejected. Please try a different file.");
  }

  if (error instanceof AppError) {
    if (error.expected) {
      logger.warn("Expected error", {
        requestId,
        code: error.code,
        status: error.status,
        message: error.message,
        userId: req.user?.id,
        path: req.originalUrl,
      });
    } else {
      logger.error("Unhandled application error", {
        requestId,
        code: error.code,
        message: error.message,
        stack: error.stack,
        context: error.context,
      });
    }

    if (res.headersSent) return undefined;

    return res.status(error.status).json({
      ...error.toJSON(),
      meta: { requestId },
    });
  }

  // Anything reaching here is a bug. Log it fully, tell the user nothing.
  logger.error("Unexpected error", {
    requestId,
    message: error?.message,
    stack: error?.stack,
    userId: req.user?.id,
    path: req.originalUrl,
    method: req.method,
  });

  if (res.headersSent) return undefined;
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our side. Please try again in a moment.",
    },
    meta: { requestId },
  });
}

function respond(res, requestId, status, code, message) {
  return res.status(status).json({ error: { code, message }, meta: { requestId } });
}

/** 404 handler for unmatched routes. */
export function notFoundHandler(req, res) {
  return res.status(404).json({
    error: { code: "NOT_FOUND", message: "That endpoint does not exist." },
    meta: { requestId: req.requestId },
  });
}

export default { requestContext, errorHandler, notFoundHandler };