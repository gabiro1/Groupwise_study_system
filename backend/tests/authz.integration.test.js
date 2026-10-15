import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

/**
 * HTTP-level authorization integration tests.
 *
 * These are genuine integration tests: they boot the real Express application
 * (`createApp`) on an ephemeral port and drive it with real HTTP requests over
 * a real TCP socket, against a real PostgreSQL database. Authentication uses
 * the real JWT verification path and authorization re-reads each user's role
 * from Postgres on every protected request. Nothing here mocks the app, the
 * middleware, or the database.
 *
 * The suite is pointed at a dedicated test database through `TEST_DATABASE_URL`
 * (falling back to a `*_test` name derived from the configured `DATABASE_URL`),
 * so it never touches a development or production database. All fixtures use a
 * unique per-run prefix and are removed in `after`, so the suite is
 * deterministic, repeatable, and safe to run alongside other work.
 *
 * Rate limits are raised through the normal environment validation path (never
 * by weakening the schema) so a full matrix run is never throttled.
 */

// ---------------------------------------------------------------------------
// Environment — set BEFORE importing the app, because `env.js` validates on
// import and `db.js` opens the pool at import time.
// ---------------------------------------------------------------------------
const RUN = randomUUID().slice(0, 8);

const rawDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  throw new Error("Integration tests require DATABASE_URL or TEST_DATABASE_URL to be set.");
}

// Derive a dedicated *_test database from the configured URL unless one is
// given explicitly, so the suite can never run against the dev/prod database.
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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || toTestDatabaseUrl(rawDatabaseUrl);

// A 32+ character secret satisfies the existing AUTH_SECRET rule; it is a
// test-only value and is never used outside this process.
const TEST_AUTH_SECRET = process.env.TEST_AUTH_SECRET || "integration-test-auth-secret-0123456789abcdef";

// Assign onto process.env: env.js and db.js read these during import.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.AUTH_SECRET = TEST_AUTH_SECRET;
// Raise every limiter well above what this suite issues. These are ordinary
// environment values that pass the existing Zod validation unchanged.
process.env.RATE_LIMIT_MAX = "100000";
process.env.AUTH_RATE_LIMIT_MAX = "100000";
process.env.AI_RATE_LIMIT_MAX = "100000";
process.env.SEARCH_RATE_LIMIT_MAX = "100000";
process.env.WRITE_RATE_LIMIT_MAX = "100000";
// Keep test output readable.
process.env.LOG_LEVEL = "silent";

// Import after the environment is configured so env validation and the pool
// use the test database. Dynamic import guarantees the ordering above.
const { createApp } = await import("../src/config/app.js");
const { pool, query, queryOne, closePool } = await import("../src/config/db.js");
const { signAccessToken } = await import("../src/lib/tokens.js");
const { hashPassword } = await import("../src/lib/crypto.js");
const { ROLES } = await import("../src/config/constants.js");

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
let server;
let baseUrl;

before(async () => {
  // Fail fast and loudly if the database is unreachable, rather than letting
  // every test error out with an opaque connection failure.
  await pool.query("SELECT 1");

  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanupFixtures();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closePool();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Emails are tagged with the run id so cleanup is precise and collision-free. */
const tag = (label) => `authz-${RUN}-${label}@example.test`;

const createdUserIds = [];
const createdGroupIds = [];
let fixtureCounter = 0;

/**
 * Create a real user row with the given role. The password is hashed so the
 * row is valid, though these tests authenticate via signed tokens.
 */
async function createUser(roleKey, label) {
  const role = await queryOne("SELECT id FROM roles WHERE key = $1", [roleKey], "test:role");
  assert.ok(role, `role ${roleKey} must exist (seed the database first)`);

  const id = randomUUID();
  await query(
    `INSERT INTO users (id, email, password_hash, role_id, status, first_name, last_name,
                        email_verified_at, password_changed_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, now(), now())`,
    [id, tag(label), await hashPassword("Authz!2026test"), role.id, label, "User"],
    "test:createUser",
  );
  createdUserIds.push(id);
  return { id, role: roleKey, roleId: role.id, email: tag(label) };
}

/** Mint a real access token exactly as the auth service does. */
function tokenFor(user) {
  return signAccessToken({
    userId: user.id,
    role: user.role,
    roleId: user.roleId,
    sessionId: randomUUID(),
    email: user.email,
    name: `${user.role} ${user.id.slice(0, 4)}`,
  });
}

/** Perform a real HTTP request against the running app; return status + body. */
async function call(method, path, { token, body, cookie, csrfToken } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: response.status, body: json, headers: response.headers };
}

/**
 * Perform the CSRF double-submit handshake against the running app and return
 * the cookie string and token to echo back on a subsequent mutating request.
 * This mirrors what a real browser does, so an unauthenticated mutating call
 * can pass CSRF and be judged on authentication alone.
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

/** Grab any active course id to satisfy NOT NULL FK requirements in fixtures. */
async function anyCourseId() {
  const row = await queryOne(
    "SELECT id FROM courses WHERE is_active ORDER BY course_code LIMIT 1",
    [],
    "test:course",
  );
  assert.ok(row, "at least one active course must be seeded");
  return row.id;
}

/**
 * Create a study group with an OWNER, a MODERATOR and a plain MEMBER, plus a
 * pending join request from a fourth student. Returns the fixtures the
 * ownership tests need.
 */
async function createGroupFixture() {
  // A unique suffix per invocation keeps emails and slugs collision-free even
  // when several tests build a group in the same run.
  const n = fixtureCounter++;
  const owner = await createUser(ROLES.STUDENT, `owner-${n}`);
  const moderator = await createUser(ROLES.STUDENT, `moderator-${n}`);
  const member = await createUser(ROLES.STUDENT, `member-${n}`);
  const requester = await createUser(ROLES.STUDENT, `requester-${n}`);
  const courseId = await anyCourseId();

  const groupId = randomUUID();
  await query(
    `INSERT INTO study_groups (id, slug, name, course_id, description, mode, privacy,
                               require_approval, min_size, max_size, owner_id, created_by_role)
     VALUES ($1, $2, $3, $4, '', 'EITHER', 'REQUEST_REQUIRED', TRUE, 3, 8, $5, 'STUDENT')`,
    [groupId, `authz-${RUN}-group-${n}`, `Authz Group ${RUN}-${n}`, courseId, owner.id],
    "test:createGroup",
  );
  createdGroupIds.push(groupId);

  // Memberships: owner, moderator, plain member. The member_count trigger keeps
  // study_groups.member_count in sync automatically.
  await query(
    `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via) VALUES
       ($1, $2, 'OWNER', 'ACTIVE', 'DIRECT'),
       ($1, $3, 'MODERATOR', 'ACTIVE', 'DIRECT'),
       ($1, $4, 'MEMBER', 'ACTIVE', 'DIRECT')`,
    [groupId, owner.id, moderator.id, member.id],
    "test:memberships",
  );

  // A pending join request from the fourth student, so "approve a join request"
  // has a real prerequisite to act on.
  const requestId = randomUUID();
  await query(
    `INSERT INTO study_group_join_requests (id, group_id, student_id, status)
     VALUES ($1, $2, $3, 'PENDING')`,
    [requestId, groupId, requester.id],
    "test:joinRequest",
  );

  return { groupId, requestId, owner, moderator, member, requester };
}

/** Remove only the fixtures this suite created, in FK-safe order. */
async function cleanupFixtures() {
  // study_groups.owner_id is ON DELETE RESTRICT, so groups go before users.
  // Deleting a group cascades to its members, requests, invitations, workspace.
  for (const groupId of createdGroupIds) {
    await query("DELETE FROM study_groups WHERE id = $1", [groupId], "test:cleanupGroup").catch(() => {});
  }
  for (const userId of createdUserIds) {
    await query("DELETE FROM users WHERE id = $1", [userId], "test:cleanupUser").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures for the read-mostly matrix sections
// ---------------------------------------------------------------------------
let student;
let admin;
let groupLeader;

before(async () => {
  student = await createUser(ROLES.STUDENT, "reader");
  admin = await createUser(ROLES.ADMIN, "admin");
  groupLeader = await createUser(ROLES.GROUP_LEADER, "leader");
});

// ===========================================================================
// A. Anonymous access
// ===========================================================================
describe("A. anonymous access is rejected with 401", () => {
  const cases = [
    ["GET", "/api/students/me"],
    ["GET", "/api/admin/users"],
    ["GET", "/api/study-groups/leader/overview"],
  ];

  for (const [method, path] of cases) {
    it(`${method} ${path} returns 401 without a token`, async () => {
      const { status, body } = await call(method, path);
      assert.equal(status, 401);
      assert.ok(body?.error, "an error envelope is returned");
    });
  }
});

// ===========================================================================
// B. Student access restrictions
// ===========================================================================
describe("B. a student is forbidden from elevated areas with 403", () => {
  it("GET /api/admin/users returns 403 for a student", async () => {
    const { status } = await call("GET", "/api/admin/users", { token: tokenFor(student) });
    assert.equal(status, 403);
  });

  it("GET /api/admin/reports returns 403 for a student", async () => {
    const { status } = await call("GET", "/api/admin/reports", { token: tokenFor(student) });
    assert.equal(status, 403);
  });

  it("GET /api/admin/group-leaders returns 403 for a student", async () => {
    const { status } = await call("GET", "/api/admin/group-leaders", { token: tokenFor(student) });
    assert.equal(status, 403);
  });

  it("GET /api/research/coverage returns 403 for a student", async () => {
    const { status } = await call("GET", "/api/research/coverage", { token: tokenFor(student) });
    assert.equal(status, 403);
  });
});

// ===========================================================================
// C. Administrator access
// ===========================================================================
describe("C. an administrator can list users", () => {
  it("GET /api/admin/users returns 200 with the documented shape", async () => {
    const { status, body } = await call("GET", "/api/admin/users?limit=5", { token: tokenFor(admin) });
    assert.equal(status, 200);
    // Response contract: { data: { users: [...], cursor } }.
    assert.ok(Array.isArray(body?.data?.users), "data.users is an array");
    assert.ok("cursor" in body.data, "a cursor field is present");
  });
});

// ===========================================================================
// D. Group leader access
// ===========================================================================
describe("D. a group leader keeps full student access but no admin access", () => {
  it("GET /api/students/me returns 200 for a group leader", async () => {
    const { status } = await call("GET", "/api/students/me", { token: tokenFor(groupLeader) });
    assert.equal(status, 200, "a group leader is still a student at heart");
  });

  it("GET /api/study-groups returns 200 for a group leader", async () => {
    const { status } = await call("GET", "/api/study-groups", { token: tokenFor(groupLeader) });
    assert.equal(status, 200);
  });

  it("GET /api/admin/users returns 403 for a group leader", async () => {
    const { status } = await call("GET", "/api/admin/users", { token: tokenFor(groupLeader) });
    assert.equal(status, 403, "group leadership is not an administrative role");
  });
});

// ===========================================================================
// E. Public registration privilege escalation
// ===========================================================================
describe("E. public registration cannot grant privileged roles", () => {
  for (const attempted of ["ADMIN", "GROUP_LEADER"]) {
    it(`rejects a registration attempt specifying role=${attempted}`, async () => {
      const email = tag(`register-${attempted.toLowerCase()}`);
      // Complete the CSRF handshake first so the request reaches the role
      // validation and account-creation path, rather than being stopped by CSRF.
      const { cookie, token } = await getCsrf();
      const { status } = await call("POST", "/api/auth/register", {
        cookie,
        csrfToken: token,
        body: {
          email,
          password: "Register!2026x",
          firstName: "Reg",
          lastName: "Attempt",
          acceptTerms: true,
          role: attempted, // must be ignored or rejected, never honoured
        },
      });

      // The register schema does not include `role`, so Zod strips it and a
      // default STUDENT account is created. Either outcome is acceptable as long
      // as no privileged account exists afterwards — assert on the database,
      // which is the security-relevant fact.
      if (status === 201) {
        const row = await queryOne(
          `SELECT r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`,
          [email],
          "test:registerRole",
        );
        assert.equal(row?.role, ROLES.STUDENT, "a self-registered account is always a STUDENT");
      } else {
        assert.ok(status >= 400 && status < 500, `expected a 4xx rejection, got ${status}`);
        const row = await queryOne("SELECT 1 FROM users WHERE email = $1", [email], "test:registerExists");
        assert.equal(row, null, "no account is created when registration is rejected");
      }

      // Definitive check regardless of branch: the requested privileged role
      // was never granted for this email.
      const privileged = await queryOne(
        `SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.email = $1 AND r.key = $2`,
        [email, attempted],
        "test:registerPrivileged",
      );
      assert.equal(privileged, null, `no ${attempted} account was created`);

      // Clean up the account this attempt created, if any.
      const created = await queryOne("SELECT id FROM users WHERE email = $1", [email], "test:registerCleanupLookup");
      if (created) {
        await query("DELETE FROM users WHERE id = $1", [created.id], "test:registerCleanup");
      }
    });
  }
});

// ===========================================================================
// F. Reports authentication
// ===========================================================================
describe("F. filing a report requires authentication", () => {
  it("an authenticated student can submit a valid report", async () => {
    // Report a real, existing target: a study group owned by a fixture user.
    const { groupId, owner } = await createGroupFixture();
    const reporter = student; // a distinct, real student

    const { status, body } = await call("POST", "/api/reports", {
      token: tokenFor(reporter),
      body: {
        targetType: "GROUP",
        targetId: groupId,
        category: "SPAM",
        details: "This group looks like spam during an authorization test.",
      },
    });

    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body?.data?.report?.id, "a report id is returned");

    // The row really persisted against the real reporter.
    const row = await queryOne(
      "SELECT reporter_id FROM reports WHERE id = $1",
      [body.data.report.id],
      "test:reportRow",
    );
    assert.equal(row.reporter_id, reporter.id);
    assert.notEqual(owner.id, reporter.id);
  });

  it("an anonymous report submission returns 401", async () => {
    // Complete the CSRF handshake (as a real browser would) so the request is
    // rejected on authentication alone, not on a missing CSRF token. This
    // isolates the 401 from requireAuth rather than a 403 from CSRF.
    const { cookie, token } = await getCsrf();
    const { status } = await call("POST", "/api/reports", {
      cookie,
      csrfToken: token,
      body: {
        targetType: "GROUP",
        targetId: randomUUID(),
        category: "SPAM",
        details: "Anonymous report should never be accepted.",
      },
    });
    assert.equal(status, 401);
  });
});

// ===========================================================================
// G. Group leadership and ownership authorization
// ===========================================================================
describe("G. group owner-only operations", () => {
  it("approving a join request: member is forbidden, owner succeeds", async () => {
    const fx = await createGroupFixture();

    // A plain MEMBER is rejected and the request stays PENDING.
    const denied = await call("POST", `/api/study-groups/${fx.groupId}/requests/${fx.requestId}/decide`, {
      token: tokenFor(fx.member),
      body: { decision: "APPROVE" },
    });
    assert.equal(denied.status, 403, "a plain member cannot decide a join request");

    const stillPending = await queryOne(
      "SELECT status FROM study_group_join_requests WHERE id = $1",
      [fx.requestId],
      "test:requestUnchanged",
    );
    assert.equal(stillPending.status, "PENDING", "database state is unchanged after the 403");

    // The OWNER succeeds and the requester becomes a member.
    const allowed = await call("POST", `/api/study-groups/${fx.groupId}/requests/${fx.requestId}/decide`, {
      token: tokenFor(fx.owner),
      body: { decision: "APPROVE" },
    });
    assert.equal(allowed.status, 200, `owner approve should be 200, got ${allowed.status}`);

    const approved = await queryOne(
      "SELECT status FROM study_group_join_requests WHERE id = $1",
      [fx.requestId],
      "test:requestApproved",
    );
    assert.equal(approved.status, "APPROVED");

    const membership = await queryOne(
      "SELECT 1 FROM study_group_members WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL",
      [fx.groupId, fx.requester.id],
      "test:requesterJoined",
    );
    assert.ok(membership, "the approved requester is now a member");
  });

  it("changing group privacy: member is forbidden, owner succeeds", async () => {
    const fx = await createGroupFixture();

    const denied = await call("PATCH", `/api/study-groups/${fx.groupId}`, {
      token: tokenFor(fx.member),
      body: { privacy: "PUBLIC" },
    });
    assert.equal(denied.status, 403, "a plain member cannot change privacy");

    const unchanged = await queryOne(
      "SELECT privacy FROM study_groups WHERE id = $1",
      [fx.groupId],
      "test:privacyUnchanged",
    );
    assert.equal(unchanged.privacy, "REQUEST_REQUIRED", "privacy is unchanged after the 403");

    const allowed = await call("PATCH", `/api/study-groups/${fx.groupId}`, {
      token: tokenFor(fx.owner),
      body: { privacy: "PUBLIC" },
    });
    assert.equal(allowed.status, 200, `owner privacy change should be 200, got ${allowed.status}`);

    const changed = await queryOne(
      "SELECT privacy FROM study_groups WHERE id = $1",
      [fx.groupId],
      "test:privacyChanged",
    );
    assert.equal(changed.privacy, "PUBLIC");
  });

  it("promoting/demoting members: member is forbidden, owner succeeds", async () => {
    const fx = await createGroupFixture();

    // A plain member tries to promote — forbidden, no change.
    const denied = await call("POST", `/api/study-groups/${fx.groupId}/members/${fx.member.id}`, {
      token: tokenFor(fx.member),
      body: { action: "PROMOTE" },
    });
    assert.equal(denied.status, 403, "a plain member cannot change roles");

    const unchanged = await queryOne(
      "SELECT role FROM study_group_members WHERE group_id = $1 AND student_id = $2",
      [fx.groupId, fx.member.id],
      "test:roleUnchanged",
    );
    assert.equal(unchanged.role, "MEMBER", "role is unchanged after the 403");

    // The owner demotes the moderator — succeeds.
    const allowed = await call("POST", `/api/study-groups/${fx.groupId}/members/${fx.moderator.id}`, {
      token: tokenFor(fx.owner),
      body: { action: "DEMOTE" },
    });
    assert.equal(allowed.status, 200, `owner demote should be 200, got ${allowed.status}`);

    const demoted = await queryOne(
      "SELECT role FROM study_group_members WHERE group_id = $1 AND student_id = $2",
      [fx.groupId, fx.moderator.id],
      "test:roleDemoted",
    );
    assert.equal(demoted.role, "MEMBER");
  });

  it("transferring ownership: member is forbidden, owner transfers and is demoted", async () => {
    const fx = await createGroupFixture();

    const denied = await call("POST", `/api/study-groups/${fx.groupId}/transfer-ownership`, {
      token: tokenFor(fx.member),
      body: { newOwnerId: fx.member.id },
    });
    assert.equal(denied.status, 403, "a plain member cannot transfer ownership");

    const ownerUnchanged = await queryOne(
      "SELECT owner_id FROM study_groups WHERE id = $1",
      [fx.groupId],
      "test:ownerUnchanged",
    );
    assert.equal(ownerUnchanged.owner_id, fx.owner.id, "owner is unchanged after the 403");

    // The owner transfers to the moderator.
    const allowed = await call("POST", `/api/study-groups/${fx.groupId}/transfer-ownership`, {
      token: tokenFor(fx.owner),
      body: { newOwnerId: fx.moderator.id },
    });
    assert.equal(allowed.status, 200, `owner transfer should be 200, got ${allowed.status}`);

    const group = await queryOne("SELECT owner_id FROM study_groups WHERE id = $1", [fx.groupId], "test:newOwner");
    assert.equal(group.owner_id, fx.moderator.id, "the new owner is recorded");

    // The former owner is demoted to MEMBER and there is exactly one owner.
    const formerOwner = await queryOne(
      "SELECT role FROM study_group_members WHERE group_id = $1 AND student_id = $2",
      [fx.groupId, fx.owner.id],
      "test:formerOwnerRole",
    );
    assert.equal(formerOwner.role, "MEMBER", "the former owner is demoted to MEMBER");

    const ownerCount = await queryOne(
      "SELECT count(*)::int AS n FROM study_group_members WHERE group_id = $1 AND role = 'OWNER' AND left_at IS NULL",
      [fx.groupId],
      "test:ownerCount",
    );
    assert.equal(ownerCount.n, 1, "the group has exactly one owner");

    // A subsequent owner-only operation by the former owner is now rejected.
    const afterTransfer = await call("PATCH", `/api/study-groups/${fx.groupId}`, {
      token: tokenFor(fx.owner),
      body: { privacy: "INVITE_ONLY" },
    });
    assert.equal(afterTransfer.status, 403, "the former owner can no longer perform owner-only changes");
  });
});

// ===========================================================================
// H. Immediate role demotion
// ===========================================================================
describe("H. a role change takes effect immediately, not at token expiry", () => {
  it("denies an admin endpoint after the role is demoted in the database", async () => {
    // 1–2. A real administrative user with a valid access token.
    const demoted = await createUser(ROLES.ADMIN, "demote");
    const token = tokenFor(demoted);

    // 3. The token can reach an admin-only endpoint.
    const before = await call("GET", "/api/admin/users?limit=1", { token });
    assert.equal(before.status, 200, "the token works while the user is an admin");

    // 4. Demote to STUDENT in Postgres WITHOUT issuing a replacement token.
    const studentRole = await queryOne("SELECT id FROM roles WHERE key = $1", [ROLES.STUDENT], "test:studentRole");
    await query("UPDATE users SET role_id = $2 WHERE id = $1", [demoted.id, studentRole.id], "test:demote");

    // 5–6. The same token is now denied, because the gate re-reads the role.
    const after = await call("GET", "/api/admin/users?limit=1", { token });
    assert.equal(after.status, 403, "the stale token no longer grants admin access");
  });
});
