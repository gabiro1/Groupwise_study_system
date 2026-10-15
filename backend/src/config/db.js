import pg from "pg";
import env from "./env.js";
import logger from "./logger.js";

const { Pool, types } = pg;

/**
 * `bigint` (OID 20) and `numeric` (OID 1700) arrive as strings so that no
 * precision is silently lost. Counts come back as numbers because nothing in
 * this schema stores a count above Number.MAX_SAFE_INTEGER.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number.parseFloat(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  application_name: env.APP_NAME,
  ssl: env.databaseSsl ? { rejectUnauthorized: env.databaseSslRejectUnauthorized } : undefined,
});

pool.on("error", (error) => {
  logger.error("Unexpected idle client error", { error: error.message, code: error.code });
});

/** Pool statistics, surfaced on the health endpoint for observability. */
export function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

/**
 * Translate Postgres error codes into safe, actionable domain errors.
 * Raw driver messages are logged but never returned to the client.
 */
function translateDatabaseError(error, context) {
  logger.error("Database query failed", {
    context,
    code: error.code,
    message: error.message,
    detail: error.detail,
  });

  // Domain trigger guards (session/meeting overlap) raise with a marker in the
  // message. Map them to 409 before the generic code switch — the driver
  // reports them as P0001, which would otherwise become a 500.
  const marker = `${error.message || ""} ${error.detail || ""} ${error.hint || ""}`;
  if (marker.includes("MEETING_OVERLAP") || marker.includes("Another meeting already occupies")) {
    return Object.assign(new Error("Another meeting already occupies part of that time slot."), {
      status: 409,
      code: "MEETING_OVERLAP",
    });
  }
  if (marker.includes("SESSION_OVERLAP")) {
    return Object.assign(new Error("Another session already occupies part of that time slot."), {
      status: 409,
      code: "SESSION_OVERLAP",
    });
  }

  switch (error.code) {
    case "23505":
      return Object.assign(new Error("That record already exists."), {
        status: 409,
        code: "DUPLICATE",
        fields: error.constraint,
      });
    case "23503":
      return Object.assign(new Error("A referenced record does not exist."), {
        status: 400,
        code: "INVALID_REFERENCE",
      });
    case "23514":
    case "22P02":
      return Object.assign(new Error("Some of the values provided are not valid."), {
        status: 400,
        code: "INVALID_VALUE",
      });
    case "57014":
      return Object.assign(new Error("The request took too long and was cancelled."), {
        status: 503,
        code: "QUERY_TIMEOUT",
      });
    default:
      return Object.assign(new Error("We could not complete that request. Please try again."), {
        status: 500,
        code: "DATABASE_ERROR",
      });
  }
}

/**
 * Run a single parameterised query.
 *
 * Every call site uses bound parameters ($1, $2, ...) — no SQL string is ever
 * built from user input, which is what makes SQL injection structurally
 * impossible here rather than merely unlikely.
 */
export async function query(text, params = [], context = "query") {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs > 250) {
      logger.warn("Slow database query", { context, durationMs: Math.round(durationMs) });
    }
    return result;
  } catch (error) {
    throw translateDatabaseError(error, context);
  }
}

/** Convenience wrapper returning only the rows. */
export async function queryRows(text, params = [], context = "query") {
  const result = await query(text, params, context);
  return result.rows;
}

/** Convenience wrapper returning the first row or `null`. */
export async function queryOne(text, params = [], context = "query") {
  const result = await query(text, params, context);
  return result.rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction, passing it a client bound to the same
 * parameterised helpers. Rolls back on any throw.
 */
export async function withTransaction(fn, context = "transaction") {
  const client = await pool.connect();
  const scopedQuery = async (text, params = []) => {
    try {
      return await client.query(text, params);
    } catch (error) {
      throw translateDatabaseError(error, context);
    }
  };

  try {
    await client.query("BEGIN");
    const result = await fn({
      query: scopedQuery,
      queryRows: async (text, params = []) => (await scopedQuery(text, params)).rows,
      queryOne: async (text, params = []) => (await scopedQuery(text, params)).rows[0] ?? null,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("Transaction rollback failed", { message: rollbackError.message });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function healthcheck() {
  const startedAt = process.hrtime.bigint();
  await pool.query("SELECT 1");
  return {
    ok: true,
    latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
  };
}

export async function closePool() {
  await pool.end();
}

export default { pool, query, queryRows, queryOne, withTransaction, healthcheck, closePool, poolStats };