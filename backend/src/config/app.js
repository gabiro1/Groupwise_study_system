import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import env from "./env.js";
import logger from "./logger.js";
import { requestContext, errorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { csrfProtection } from "../middleware/csrf.js";
import { globalLimiter } from "../middleware/rateLimit.js";
import { healthcheck, poolStats } from "./db.js";
import { ForbiddenError } from "../lib/errors.js";

import authRoutes from "../routes/auth.routes.js";
import academicRoutes from "../routes/academic.routes.js";
import studentsRoutes from "../routes/students.routes.js";
import studyGroupsRoutes from "../routes/studyGroups.routes.js";
import partnersRoutes from "../routes/partners.routes.js";
import workspacesRoutes from "../routes/workspaces.routes.js";
import recommendationsRoutes from "../routes/recommendations.routes.js";
import aiRoutes from "../routes/ai.routes.js";
import notificationsRoutes from "../routes/notifications.routes.js";
import lecturerRoutes from "../routes/lecturer.routes.js";
import adminRoutes, { reportRouter } from "../routes/admin.routes.js";
import researchRoutes from "../routes/research.routes.js";
import contactRoutes from "../routes/contact.routes.js";

/**
 * Express application assembly.
 *
 * Middleware order here is deliberate and load-bearing:
 *
 *   1. trust proxy      — so rate limiting and audit IPs see the real client
 *   2. helmet           — security headers before anything can respond
 *   3. cors             — explicit allowlist, never a wildcard with credentials
 *   4. body parsing     — with a tight size limit
 *   5. cookies          — required by CSRF and auth
 *   6. request context  — request id, so every later log line correlates
 *   7. global limiter   — after context, so rejected requests still get an id
 *   8. CSRF             — after cookies, before every route
 *   9. routes
 *  10. 404, then error handler (must be last)
 */
export function createApp() {
  const app = express();

  // Required behind a reverse proxy so `req.ip` is the client, not the proxy.
  // Only enabled explicitly: trusting X-Forwarded-For blindly lets a client
  // spoof its own IP and evade rate limiting.
  app.set("trust proxy", env.trustProxy ? 1 : false);
  app.disable("x-powered-by");

  // ---- Security headers ---------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The API only serves JSON and files; no inline scripts anywhere.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: env.isProduction ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
    }),
  );

  // ---- CORS --------------------------------------------------------------
  // A wildcard origin combined with credentials is rejected by browsers and
  // would be a CSRF vector, so the allowlist is explicit.
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        logger.warn("Blocked cross-origin request", { origin });
        return callback(new ForbiddenError("This origin is not allowed to call the Lien API."));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "Retry-After", "RateLimit", "RateLimit-Policy"],
      maxAge: 600,
    }),
  );

  // ---- Body parsing ------------------------------------------------------
  app.use(
    express.json({
      limit: "256kb",
      // Reject prototype-pollution payloads outright.
      verify: (req, _res, buffer) => {
        const text = buffer.toString("utf8");
        if (text.includes("__proto__") || text.includes("constructor.prototype")) {
          throw Object.assign(new Error("Malformed payload"), { status: 400, code: "UNSAFE_PAYLOAD" });
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.use(cookieParser());

  // ---- Request context & global limit -------------------------------------
  app.use(requestContext);
  app.use(globalLimiter);

  // ---- Operational endpoints ---------------------------------------------
  // Registered before CSRF since they are unauthenticated GETs.
  app.get("/health", async (_req, res) => {
    try {
      const db = await healthcheck();
      res.json({
        status: "ok",
        service: env.APP_NAME,
        database: db,
        pool: poolStats(),
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Health check failed", { message: error.message });
      res.status(503).json({
        status: "degraded",
        // Deliberately no internals: this endpoint is often publicly reachable.
        message: "The database is not responding.",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ---- CSRF --------------------------------------------------------------
  app.use(csrfProtection);

  // ---- Routes ------------------------------------------------------------
  // Reporting is mounted before the admin router because filing a report is
  // available to any signed-in user, not just staff.
  app.use("/api/reports", reportRouter);
  app.use("/api/auth", authRoutes);
  app.use("/api/academic", academicRoutes);
  app.use("/api/students", studentsRoutes);
  app.use("/api/study-groups", studyGroupsRoutes);
  app.use("/api/partners", partnersRoutes);
  app.use("/api/workspaces", workspacesRoutes);
  app.use("/api/recommendations", recommendationsRoutes);
  app.use("/api/ai", aiRoutes);
  app.use("/api/notifications", notificationsRoutes);
  app.use("/api/lecturer", lecturerRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/research", researchRoutes);
  app.use("/api/contact", contactRoutes);

  // ---- Terminal handlers --------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;