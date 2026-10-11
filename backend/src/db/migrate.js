import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, queryRows, withTransaction } from "../config/db.js";
import logger from "../config/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

/**
 * Minimal, dependency-free migration runner.
 *
 * Migrations are plain SQL files applied in filename order inside a single
 * transaction each, with an advisory lock so two instances starting at once
 * cannot race. Deliberately simple: this project needs ordered DDL replay, not
 * a migration framework with a DSL.
 */

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms INTEGER NOT NULL DEFAULT 0
  )
`;

/** SHA-256 of the file contents, used to detect edited-after-apply migrations. */
async function checksum(contents) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

export async function listMigrations() {
  const files = await readdir(migrationsDir);
  return files.filter((name) => name.endsWith(".sql")).sort();
}

export async function appliedMigrations() {
  const rows = await queryRows("SELECT filename, checksum FROM schema_migrations ORDER BY filename", [], "migrations:applied");
  return new Map(rows.map((row) => [row.filename, row.checksum]));
}

/** Acquire a session-scoped advisory lock; released automatically on exit. */
async function withAdvisoryLock(fn) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [7271_2024]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [7271_2024]).catch(() => {});
    client.release();
  }
}

export async function runMigrations({ logger: log = logger } = {}) {
  return withAdvisoryLock(async () => {
    await pool.query(MIGRATIONS_TABLE);
    const applied = await appliedMigrations();
    const files = await listMigrations();
    const results = [];

    for (const filename of files) {
      const sql = await readFile(join(migrationsDir, filename), "utf8");
      const sum = await checksum(sql);

      if (applied.has(filename)) {
        if (applied.get(filename) !== sum) {
          log.warn("Migration was modified after being applied", { filename });
        }
        results.push({ filename, status: "skipped" });
        continue;
      }

      const startedAt = Date.now();
      // A single transaction per file: Postgres DDL is transactional, so a
      // failure halfway through leaves no partially-created schema.
      await withTransaction(async ({ query: run }) => {
        await run(sql);
        await run(
          "INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)",
          [filename, sum, Date.now() - startedAt],
        );
      }, `migration:${filename}`);

      log.info("Migration applied", { filename, durationMs: Date.now() - startedAt });
      results.push({ filename, status: "applied", durationMs: Date.now() - startedAt });
    }

    return results;
  });
}

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  runMigrations()
    .then(async (results) => {
      const applied = results.filter((r) => r.status === "applied");
      // eslint-disable-next-line no-console
      console.log(
        applied.length
          ? `Applied ${applied.length} migration(s): ${applied.map((r) => r.filename).join(", ")}`
          : "Database is already up to date.",
      );
      await pool.end();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error("Migration failed:", error.message);
      await pool.end();
      process.exit(1);
    });
}