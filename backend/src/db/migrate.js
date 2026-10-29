import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, queryOne, queryRows, withTransaction } from "../config/db.js";
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

/**
 * Read-only migration report used by `npm run migrate:status`.
 *
 * Unlike `runMigrations` this never creates the tracking table, applies SQL, or
 * takes the advisory lock: a status command must be safe to run against any
 * environment, including production.
 */
export async function migrationStatus() {
  const files = await listMigrations();
  const table = await queryOne(
    "SELECT to_regclass('public.schema_migrations') AS name",
    [],
    "migrations:status",
  );
  const applied = table?.name ? await appliedMigrations() : new Map();
  const results = [];

  for (const filename of files) {
    const sql = await readFile(join(migrationsDir, filename), "utf8");
    const sum = await checksum(sql);
    // Git may check the same file out with CRLF on Windows and LF on Linux.
    // Accept either checksum when reporting, so a line-ending difference is not
    // misreported as an edited migration.
    const lfSum = await checksum(sql.replace(/\r\n/g, "\n"));
    const appliedChecksum = applied.get(filename);

    results.push({
      filename,
      status: appliedChecksum === undefined
        ? "pending"
        : appliedChecksum === sum || appliedChecksum === lfSum ? "applied" : "modified",
    });
  }

  return results;
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
  if (process.argv.includes("--status")) {
    migrationStatus()
      .then(async (results) => {
        const pending = results.filter((result) => result.status === "pending");
        const modified = results.filter((result) => result.status === "modified");
        const applied = results.length - pending.length - modified.length;

        // eslint-disable-next-line no-console
        console.log(
          `Migration status: ${applied} applied, ${pending.length} pending, ${modified.length} modified (${results.length} file(s)).`,
        );
        for (const result of results) {
          // eslint-disable-next-line no-console
          console.log(`  ${result.status.padEnd(8)} ${result.filename}`);
        }
        if (modified.length) {
          // eslint-disable-next-line no-console
          console.log("Warning: migrations marked modified changed after they were applied.");
        }
        await pool.end();
      })
      .catch(async (error) => {
        // eslint-disable-next-line no-console
        console.error("Could not read migration status:", error.message);
        await pool.end();
        process.exitCode = 1;
      });
  } else {
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
}