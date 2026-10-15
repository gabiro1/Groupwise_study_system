import env from "./config/env.js";
import logger from "./config/logger.js";
import { createApp } from "./config/app.js";
import { healthcheck, closePool } from "./config/db.js";
import { runMigrations } from "./db/migrate.js";
import { initRealtime } from "./lib/realtime.js";

/**
 * Server bootstrap.
 *
 * Startup order matters:
 *   1. Verify the database is reachable — failing fast here is far kinder than
 *      serving 500s to the first user.
 *   2. Run pending migrations when explicitly enabled.
 *   3. Start listening.
 *   4. Install graceful shutdown handlers so in-flight requests finish and
 *      pooled connections are released on deploy.
 */

const app = createApp();

async function start() {
  try {
    const db = await healthcheck();
    logger.info("Database connection established", { latencyMs: db.latencyMs });
  } catch (error) {
    logger.error("Could not reach the database — refusing to start", {
      message: error.message,
      hint: "Check DATABASE_URL and that Postgres is running.",
    });
    process.exit(1);
  }

  // Migrations are opt-in so a production deploy can run them as a separate
  // release step rather than from every instance at once.
  if (env.RUN_MIGRATIONS_ON_BOOT === "true") {
    try {
      const results = await runMigrations();
      const applied = results.filter((r) => r.status === "applied");
      if (applied.length) logger.info("Migrations applied on boot", { count: applied.length });
    } catch (error) {
      logger.error("Migration failed on boot", { message: error.message });
      process.exit(1);
    }
  }

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info("Lien API listening", {
      port: env.PORT,
      host: env.HOST,
      env: env.NODE_ENV,
      aiEnabled: env.aiEnabled,
      aiProvider: env.AI_PROVIDER,
    });
  });

  // Attach the Socket.IO push layer to the *same* HTTP server so one port
  // serves both the REST API and the realtime events.
  try {
    initRealtime(server);
  } catch (error) {
    // Realtime is an enhancement: REST remains the source of truth. A failed
    // init must not take the whole API down, but it must be loud.
    logger.error("Failed to initialise realtime layer", { message: error.message });
  }

  // Slightly above a typical 60s proxy timeout, so the proxy closes idle
  // connections first and we do not race it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // ---- Graceful shutdown --------------------------------------------------
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });

    // Stop accepting new connections, then drain in-flight ones.
    const forced = setTimeout(() => {
      logger.error("Forcing shutdown — connections did not drain in time");
      process.exit(1);
    }, 15_000);
    forced.unref();

    server.close(async (error) => {
      if (error) logger.error("Error closing HTTP server", { message: error.message });
      try {
        await closePool();
        logger.info("Database pool closed");
      } catch (poolError) {
        logger.error("Error closing database pool", { message: poolError.message });
      }
      clearTimeout(forced);
      process.exit(error ? 1 : 0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // A crash should log loudly and exit; the orchestrator restarts us.
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception — exiting", { message: error.message, stack: error.stack });
    shutdown("uncaughtException").catch(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  return server;
}

start().catch((error) => {
  logger.error("Fatal startup error", { message: error.message, stack: error.stack });
  process.exit(1);
});

export default app;