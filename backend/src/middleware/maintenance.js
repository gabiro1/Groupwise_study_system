import { maintenanceState } from "../services/settings.service.js";
import logger from "../config/logger.js";

/**
 * Maintenance-mode gate.
 *
 * The message is operator-controlled and always shown verbatim; there is no
 * generic "something went wrong" here, because maintenance is expected.
 *
 * Exempt paths:
 *   - `/health`      so infrastructure probes keep working;
 *   - `/api/auth`    so an administrator can sign in and switch it off;
 *   - `/api/admin`   so the console that controls it stays reachable.
 *
 * Every other product endpoint returns 503 with a stable `MAINTENANCE_MODE`
 * code, which the frontend renders as a maintenance screen rather than an error.
 */
const EXEMPT_PREFIXES = ["/health", "/api/auth", "/api/admin"];

export async function maintenanceGuard(req, res, next) {
  try {
    if (req.method === "OPTIONS") return next();
    if (EXEMPT_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      return next();
    }

    const state = await maintenanceState();
    if (!state.enabled) return next();

    return res.status(503).json({
      error: {
        code: "MAINTENANCE_MODE",
        message: state.message,
      },
    });
  } catch (error) {
    // A settings read failure must not take the API down. The request proceeds
    // normally rather than turning every endpoint into a 500.
    logger.warn("Maintenance check failed; allowing the request", { message: error.message });
    return next();
  }
}

export default { maintenanceGuard };
