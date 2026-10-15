  import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Admin academic-taxonomy CRUD — HTTP integration tests.
 *
 * Boots the real app on an ephemeral port against the real test database and
 * exercises the course create/edit/archive endpoints, including the
 * authorization boundary (admin-only), validation, and not-found handling.
 * Uses the same dedicated-test-database and CSRF conventions as the authz
 * suite so the two never touch a development or production database.
 */

const RUN = randomUUID().slice(0, 8);

const rawDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  throw new Error("These tests require DATABASE_URL or TEST_DATABASE_URL to be set.");
}

function toTestDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    const dbName = parsed.pathname.replace(/^\//, "");
    if (!dbName || /_test$/.test(dbName)) return url;
    parsed.pathname = `/${dbName}_test`;
    return parsed.toString();
  } catch {
    return url;
  }
}

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || toTestDatabaseUrl(rawDatabaseUrl);
process.env.AUTH_SECRET = process.env.TEST_AUTH_SECRET || "integration-test-auth-secret-0123456789abcdef";
process.env.RATE_LIMIT_MAX = "100000";
process.env.AUTH_RATE_LIMIT_MAX = "100000";
process.env.SEARCH_RATE_LIMIT_MAX = "100000";
process.env.WRITE_RATE_LIMIT_MAX = "100000";
process.env.LOG_LEVEL = "silent";

const { createApp } = await import("../src/config/app.js");
const { pool, query, queryOne, closePool } = await import("../src/config/db.js");
const { signAccessToken } = await import("../src/lib/tokens.js");
const { ROLES } = await import("../src/config/constants.js");

let server;
let baseUrl;
const createdEmails = [];
const createdCourseIds = [];

before(async () => {
  await pool.query("SELECT 1");
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const courseId of createdCourseIds) {
    await query("DELETE FROM courses WHERE id = $1", [courseId], "test:cleanupCourse").catch(() => {});
  }
  for (const email of createdEmails) {
    await query("DELETE FROM users WHERE email = $1", [email], "test:cleanupUser").catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
});

let userSeq = 0;
async function createUser(roleKey, label) {
  const role = await queryOne("SELECT id FROM roles WHERE key = $1", [roleKey], "test:role");
  const id = randomUUID();
  // Several tests reuse the same label ("admin", "student"); a per-call
  // counter keeps every email unique within the run.
  const email = `acr-${RUN}-${label}-${(userSeq += 1)}@example.test`;
  await query(
    `INSERT INTO users (id, email, password_hash, role_id, status, first_name, last_name, email_verified_at)
     VALUES ($1, $2, 'x', $3, 'ACTIVE', $4, 'User', now())`,
    [id, email, role.id, label],
    "test:createUser",
  );
  createdEmails.push(email);
  const token = signAccessToken({ userId: id, role: roleKey, roleId: role.id, sessionId: randomUUID(), email, name: label });
  return { id, email, token, role: roleKey };
}

async function call(method, path, { token, body, csrf } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (csrf) {
    headers.cookie = csrf.cookie;
    headers["x-csrf-token"] = csrf.token;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  return { status: response.status, body: json };
}

const uniqueCode = () => `T${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 900 + 100)}`;

/**
 * Perform the CSRF double-submit handshake against the running app and return
 * the cookie string and token to echo back on a subsequent mutating request.
 * A browser always holds these before posting, so an anonymous POST that wants
 * to be judged on authentication alone must present them too — otherwise the
 * CSRF middleware answers 403 before auth ever runs.
 */
async function getCsrf() {
  const response = await fetch(`${baseUrl}/api/auth/csrf`, { method: "GET" });
  const json = await response.json();
  const token = json?.data?.csrfToken;
  assert.ok(token, "the csrf endpoint issues a token");
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("lien_csrf="));
  assert.ok(setCookie, "the csrf endpoint sets the lien_csrf cookie");
  const cookie = setCookie.split(";")[0];
  return { cookie, token };
}

describe("admin academic CRUD — administrator", () => {
  it("creates a valid course and persists it", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const code = uniqueCode();
    const { status, body } = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: code, name: "Integration Test Course", creditHours: 3, level: 200 },
    });
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    const course = body?.data?.course;
    assert.ok(course?.id, "a course id is returned");
    createdCourseIds.push(course.id);

    const row = await queryOne("SELECT course_code, name, is_active FROM courses WHERE id = $1", [course.id], "test:row");
    assert.equal(row.course_code.toLowerCase(), code.toLowerCase());
    assert.equal(row.name, "Integration Test Course");
    assert.equal(row.is_active, true);
  });

  it("rejects a duplicate course code with 409", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const code = uniqueCode();
    const first = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: code, name: "Original" },
    });
    assert.equal(first.status, 201);
    createdCourseIds.push(first.body.data.course.id);

    const dup = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: code, name: "Duplicate" },
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body?.error?.code, "DUPLICATE");
  });

  it("rejects invalid request data with 422 and creates nothing", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const before = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: "!!!bad", name: "Bad Code" },
    });
    assert.equal(before.status, 422);
    const none = await queryOne("SELECT 1 FROM courses WHERE name = 'Bad Code'", [], "test:none");
    assert.equal(none, null, "no partial record is left behind");

    const missing = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { name: "No Code" },
    });
    assert.equal(missing.status, 422, "a missing required field is rejected");
  });

  it("edits an existing course", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const code = uniqueCode();
    const created = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: code, name: "Before Edit" },
    });
    createdCourseIds.push(created.body.data.course.id);

    const edited = await call("PATCH", `/api/admin/academic/courses/${created.body.data.course.id}`, {
      token: admin.token,
      body: { name: "After Edit", creditHours: 4 },
    });
    assert.equal(edited.status, 200, `expected 200, got ${edited.status}`);
    assert.equal(edited.body?.data?.course?.name, "After Edit");
    assert.equal(edited.body?.data?.course?.credit_hours, 4);
  });

  it("archives a course as a soft toggle without deleting it", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const code = uniqueCode();
    const created = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: code, name: "To Archive" },
    });
    const courseId = created.body.data.course.id;
    createdCourseIds.push(courseId);

    const archived = await call("PATCH", `/api/admin/academic/courses/${courseId}`, {
      token: admin.token,
      body: { isActive: false },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body?.data?.course?.is_active, false);

    // The row still exists (soft, not destructive).
    const row = await queryOne("SELECT is_active FROM courses WHERE id = $1", [courseId], "test:archived");
    assert.ok(row, "the archived course row is retained");
    assert.equal(row.is_active, false);
  });

  it("returns 404 when editing a nonexistent course", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const { status } = await call("PATCH", `/api/admin/academic/courses/${randomUUID()}`, {
      token: admin.token,
      body: { name: "Ghost" },
    });
    assert.equal(status, 404);
  });
});

describe("admin academic CRUD — authorization boundary", () => {
  it("a non-admin cannot create a course (403)", async () => {
    const student = await createUser(ROLES.STUDENT, "student");
    const { status } = await call("POST", "/api/admin/academic/courses", {
      token: student.token,
      body: { courseCode: uniqueCode(), name: "Nope" },
    });
    assert.equal(status, 403);
  });

  it("a non-admin cannot edit a course (403)", async () => {
    const admin = await createUser(ROLES.ADMIN, "admin");
    const student = await createUser(ROLES.STUDENT, "student");
    const code = uniqueCode();
    const created = await call("POST", "/api/admin/academic/courses", {
      token: admin.token,
      body: { courseCode: code, name: "Protected" },
    });
    createdCourseIds.push(created.body.data.course.id);

    const { status } = await call("PATCH", `/api/admin/academic/courses/${created.body.data.course.id}`, {
      token: student.token,
      body: { name: "Hacked" },
    });
    assert.equal(status, 403);
    const row = await queryOne("SELECT name FROM courses WHERE id = $1", [created.body.data.course.id], "test:unchanged");
    assert.equal(row.name, "Protected", "the course is unchanged after the 403");
  });

  it("an anonymous caller cannot create a course (401)", async () => {
    // Present a valid CSRF handshake so the request is judged on
    // authentication alone rather than being stopped by the CSRF middleware.
    const csrf = await getCsrf();
    const { status } = await call("POST", "/api/admin/academic/courses", {
      csrf,
      body: { courseCode: uniqueCode(), name: "Anon" },
    });
    assert.equal(status, 401);
  });
});

