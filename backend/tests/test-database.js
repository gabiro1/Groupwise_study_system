/**
 * Shared integration-test environment guard.
 *
 * Tests must receive an explicit TEST_DATABASE_URL. Deriving a database name
 * from DATABASE_URL made it too easy to run a suite against development data,
 * and one suite previously used DATABASE_URL directly.
 */
const explicitUrl = process.env.TEST_DATABASE_URL?.trim();

if (!explicitUrl) {
  throw new Error(
    "Integration tests require an explicit TEST_DATABASE_URL. Refusing to fall back to DATABASE_URL.",
  );
}

let testUrl;
try {
  testUrl = new URL(explicitUrl);
} catch {
  throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL connection URL.");
}

if (!["postgres:", "postgresql:"].includes(testUrl.protocol)) {
  throw new Error("TEST_DATABASE_URL must use the postgres:// or postgresql:// scheme.");
}

const testDatabaseName = decodeURIComponent(testUrl.pathname.replace(/^\/+/, ""));
const baseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const sameEndpoint = baseUrl
  && testUrl.hostname === baseUrl.hostname
  && testUrl.port === baseUrl.port
  && testDatabaseName === decodeURIComponent(baseUrl.pathname.replace(/^\/+/, ""));

if (sameEndpoint || (baseUrl && testUrl.href === baseUrl.href)) {
  throw new Error("TEST_DATABASE_URL points to the same database as DATABASE_URL.");
}

// A local database should be visibly test-scoped. A provider branch may use a
// different hostname, so a different endpoint is also accepted as isolation.
const visiblyTestScoped = /(?:^|[_-])test(?:$|[_-])/i.test(testDatabaseName)
  || (baseUrl && testUrl.hostname !== baseUrl.hostname);

if (!visiblyTestScoped) {
  throw new Error("TEST_DATABASE_URL must target a test-named database or a separate provider endpoint.");
}

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = explicitUrl;
process.env.AUTH_SECRET = process.env.TEST_AUTH_SECRET || "integration-test-auth-secret-0123456789abcdef";
process.env.RATE_LIMIT_MAX = "100000";
process.env.AUTH_RATE_LIMIT_MAX = "100000";
process.env.AI_RATE_LIMIT_MAX = "100000";
process.env.SEARCH_RATE_LIMIT_MAX = "100000";
process.env.WRITE_RATE_LIMIT_MAX = "100000";
process.env.LOG_LEVEL = "silent";

export const TEST_DATABASE_URL = explicitUrl;
