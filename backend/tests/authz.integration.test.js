import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import "./test-database.js";

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
 * The suite is pointed at a dedicated test database through an explicit
 * `TEST_DATABASE_URL`,
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

/* Database and test-only environment are configured by test-database.js. */

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
const { pool, query, queryOne, queryRows, closePool } = await import("../src/config/db.js");
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
const createdReportIds = [];
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
  const sessionId = randomUUID();
  await query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, id, `test-session-${sessionId}`],
    "test:createSession",
  );
  createdUserIds.push(id);
  return { id, role: roleKey, roleId: role.id, email: tag(label), sessionId };
}

/** Mint a real access token exactly as the auth service does. */
function tokenFor(user) {
  return signAccessToken({
    userId: user.id,
    role: user.role,
    roleId: user.roleId,
    sessionId: user.sessionId,
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

  let workspace = await queryOne(
    "SELECT id FROM workspaces WHERE group_id = $1 AND NOT is_archived LIMIT 1",
    [groupId],
    "test:groupWorkspace",
  );
  if (!workspace) {
    workspace = await queryOne(
      `INSERT INTO workspaces (group_id, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [groupId, `Authz Workspace ${RUN}-${n}`, owner.id],
      "test:createWorkspace",
    );
  }
  await query(
    `INSERT INTO workspace_groups (workspace_id, group_id, assigned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, group_id) DO NOTHING`,
    [workspace.id, groupId, owner.id],
    "test:assignWorkspaceGroup",
  );
  assert.ok(workspace, "the group trigger creates an active workspace");

  return { groupId, workspaceId: workspace.id, requestId, owner, moderator, member, requester };
}

/** Remove only the fixtures this suite created, in FK-safe order. */
async function cleanupFixtures() {
  for (const reportId of createdReportIds) {
    await query("DELETE FROM reports WHERE id = $1", [reportId], "test:cleanupReport").catch(() => {});
  }
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
    createdReportIds.push(body.data.report.id);

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
  it("an administrator can review and admit a pending join request", async () => {
    const fx = await createGroupFixture();

    const detail = await call("GET", `/api/admin/groups/${fx.groupId}`, { token: tokenFor(admin) });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.joinRequests.length, 1);
    assert.equal(detail.body.data.joinRequests[0].id, fx.requestId);

    const admitted = await call("POST", `/api/admin/groups/${fx.groupId}/requests/${fx.requestId}/decide`, {
      token: tokenFor(admin),
      body: { decision: "APPROVE", note: "Leader support admission test" },
    });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    assert.equal(admitted.body.data.admitted, true);

    const state = await queryOne(
      `SELECT jr.status AS request_status, m.status AS member_status, m.joined_via,
              a.action, a.actor_id
         FROM study_group_join_requests jr
         JOIN study_group_members m ON m.group_id = jr.group_id AND m.student_id = jr.student_id
         LEFT JOIN audit_logs a ON a.entity_type = 'study_group' AND a.entity_id = jr.group_id::text
                              AND a.action = 'admin.group.join_request.decided'
        WHERE jr.id = $1
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [fx.requestId],
      "test:adminAdmitState",
    );
    assert.equal(state.request_status, "APPROVED");
    assert.equal(state.member_status, "ACTIVE");
    assert.equal(state.joined_via, "JOIN_REQUEST");
    assert.equal(state.action, "admin.group.join_request.decided");
    assert.equal(state.actor_id, admin.id);
  });

  it("a non-administrator cannot use the administrator admission endpoint", async () => {
    const fx = await createGroupFixture();

    const denied = await call("POST", `/api/admin/groups/${fx.groupId}/requests/${fx.requestId}/decide`, {
      token: tokenFor(fx.owner),
      body: { decision: "APPROVE" },
    });
    assert.equal(denied.status, 403);

    const request = await queryOne(
      "SELECT status FROM study_group_join_requests WHERE id = $1",
      [fx.requestId],
      "test:adminAdmissionDeniedState",
    );
    assert.equal(request.status, "PENDING");
  });

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

// ===========================================================================
// I. session invalidation and closed-group authorization
// ===========================================================================
describe("I. revoked sessions and closed groups cannot keep access", () => {
  it("rejects an access JWT as soon as its database session is revoked", async () => {
    const user = await createUser(ROLES.STUDENT, "revoked-session");
    await query(
      "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1",
      [user.sessionId],
      "test:revokeSession",
    );

    const response = await call("GET", "/api/students/me", { token: tokenFor(user) });
    assert.equal(response.status, 401);
  });

  it("denies workspace access while the parent group is suspended or archived", async () => {
    const fx = await createGroupFixture();

    await query(
      `UPDATE study_groups
          SET status = 'SUSPENDED', suspended_at = now(), suspended_reason = 'security test'
        WHERE id = $1`,
      [fx.groupId],
      "test:suspendGroup",
    );
    const suspended = await call("GET", `/api/workspaces/${fx.workspaceId}`, { token: tokenFor(fx.owner) });
    assert.equal(suspended.status, 404);

    await query(
      "UPDATE study_groups SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [fx.groupId],
      "test:archiveGroup",
    );
    const archived = await call("GET", `/api/workspaces/${fx.workspaceId}`, { token: tokenFor(fx.owner) });
    assert.equal(archived.status, 404);
  });

  it("does not restore an archived group through the suspension restore route", async () => {
    const fx = await createGroupFixture();
    await query(
      "UPDATE study_groups SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [fx.groupId],
      "test:archiveBeforeRestore",
    );

    const response = await call("POST", `/api/admin/groups/${fx.groupId}/restore`, {
      token: tokenFor(admin),
      body: { reason: "should not restore an owner-archived group" },
    });
    assert.equal(response.status, 409);
    const row = await queryOne("SELECT status FROM study_groups WHERE id = $1", [fx.groupId], "test:restoreState");
    assert.equal(row.status, "ARCHIVED");
  });

  it("archives a group and closes its workspace and pending requests", async () => {
    const fx = await createGroupFixture();

    const response = await call("POST", `/api/admin/groups/${fx.groupId}/archive`, {
      token: tokenFor(admin),
      body: { reason: "archive cascade test" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const state = await queryOne(
      `SELECT g.status, w.is_archived, jr.status AS request_status
         FROM study_groups g
         JOIN workspaces w ON w.id = $2
         LEFT JOIN study_group_join_requests jr ON jr.id = $3
        WHERE g.id = $1`,
      [fx.groupId, fx.workspaceId, fx.requestId],
      "test:archiveCascadeState",
    );
    assert.equal(state.status, "ARCHIVED");
    assert.equal(state.is_archived, true);
    assert.equal(state.request_status, "CANCELLED");
  });
});

// ===========================================================================
// J. report privacy and moderation invariants
// ===========================================================================
describe("J. reports do not disclose private targets", () => {
  it("returns the same not-found result for private group, message and resource targets", async () => {
    const fx = await createGroupFixture();
    await query("UPDATE study_groups SET privacy = 'INVITE_ONLY' WHERE id = $1", [fx.groupId], "test:privateGroup");

    const groupReport = await call("POST", "/api/reports", {
      token: tokenFor(student),
      body: {
        targetType: "GROUP",
        targetId: fx.groupId,
        category: "SPAM",
        details: "This private group should not be probeable.",
      },
    });
    assert.equal(groupReport.status, 404);

    const message = await queryOne(
      `INSERT INTO messages (workspace_id, author_id, kind, body)
       VALUES ($1, $2, 'TEXT', 'private message for the authorization test')
       RETURNING id`,
      [fx.workspaceId, fx.owner.id],
      "test:privateMessage",
    );
    const messageReport = await call("POST", "/api/reports", {
      token: tokenFor(student),
      body: {
        targetType: "MESSAGE",
        targetId: message.id,
        category: "HARASSMENT",
        details: "This private message should not be probeable.",
      },
    });
    assert.equal(messageReport.status, 404);

    const resource = await queryOne(
      `INSERT INTO resources
         (workspace_id, uploaded_by, title, description, kind, visibility, extracted_text, extraction_status)
       VALUES ($1, $2, 'Private note', '', 'NOTE', 'PRIVATE', 'private resource text', 'SKIPPED')
       RETURNING id`,
      [fx.workspaceId, fx.owner.id],
      "test:privateResource",
    );
    const resourceReport = await call("POST", "/api/reports", {
      token: tokenFor(student),
      body: {
        targetType: "RESOURCE",
        targetId: resource.id,
        category: "INAPPROPRIATE_CONTENT",
        details: "This private resource should not be probeable.",
      },
    });
    assert.equal(resourceReport.status, 404);
  });

  it("does not return a private message body in admin report detail", async () => {
    const fx = await createGroupFixture();
    const message = await queryOne(
      `INSERT INTO messages (workspace_id, author_id, kind, body)
       VALUES ($1, $2, 'TEXT', 'body must never be returned to report detail')
       RETURNING id`,
      [fx.workspaceId, fx.owner.id],
      "test:messageForDetail",
    );
    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, 'MESSAGE', $2, 'HARASSMENT', 'message detail privacy test')
       RETURNING id`,
      [fx.member.id, message.id],
      "test:detailReport",
    );
    createdReportIds.push(report.id);

    const response = await call("GET", `/api/admin/reports/${report.id}`, { token: tokenFor(admin) });
    assert.equal(response.status, 200);
    assert.equal(response.body?.data?.target?.body, undefined);
    assert.notEqual(response.body?.data?.target?.source, undefined);
  });
});

describe("K. report moderation is target-bound and transactional", () => {
  it("rejects an incompatible action without closing the report", async () => {
    const fx = await createGroupFixture();
    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, 'GROUP', $2, 'SPAM', 'incompatible report action test')
       RETURNING id`,
      [fx.member.id, fx.groupId],
      "test:incompatibleReport",
    );
    createdReportIds.push(report.id);

    const response = await call("POST", "/api/admin/reports/resolve", {
      token: tokenFor(admin),
      body: { reportId: report.id, status: "RESOLVED", action: "REMOVE_CONTENT" },
    });
    assert.equal(response.status, 422);
    const row = await queryOne("SELECT status FROM reports WHERE id = $1", [report.id], "test:reportStillOpen");
    assert.equal(row.status, "OPEN");
  });

  it("cannot suspend an administrator through report moderation", async () => {
    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, 'STUDENT', $2, 'ABUSE', 'administrator suspension protection test')
       RETURNING id`,
      [student.id, admin.id],
      "test:adminTargetReport",
    );
    createdReportIds.push(report.id);

    const response = await call("POST", "/api/admin/reports/resolve", {
      token: tokenFor(admin),
      body: { reportId: report.id, status: "RESOLVED", action: "SUSPEND_USER" },
    });
    assert.equal(response.status, 403);
    const row = await queryOne("SELECT status FROM users WHERE id = $1", [admin.id], "test:adminStillActive");
    assert.equal(row.status, "ACTIVE");
  });

  it("leaves a report open when its requested content removal is no longer possible", async () => {
    const fx = await createGroupFixture();
    const message = await queryOne(
      `INSERT INTO messages (workspace_id, author_id, kind, body)
       VALUES ($1, $2, 'TEXT', 'content will disappear before moderation')
       RETURNING id`,
      [fx.workspaceId, fx.owner.id],
      "test:staleMessage",
    );
    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, 'MESSAGE', $2, 'SPAM', 'stale content action test')
       RETURNING id`,
      [fx.member.id, message.id],
      "test:staleReport",
    );
    createdReportIds.push(report.id);
    await query("UPDATE messages SET deleted_at = now() WHERE id = $1", [message.id], "test:deleteBeforeModeration");

    const response = await call("POST", "/api/admin/reports/resolve", {
      token: tokenFor(admin),
      body: { reportId: report.id, status: "RESOLVED", action: "REMOVE_CONTENT" },
    });
    assert.equal(response.status, 409);
    const row = await queryOne("SELECT status FROM reports WHERE id = $1", [report.id], "test:staleReportOpen");
    assert.equal(row.status, "OPEN");
  });

  it("delivers a warning notification before resolving a student report", async () => {
    const target = await createUser(ROLES.STUDENT, "warn-target");
    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, 'STUDENT', $2, 'ABUSE', 'warning notification delivery test')
       RETURNING id`,
      [student.id, target.id],
      "test:warningReport",
    );
    createdReportIds.push(report.id);

    const response = await call("POST", "/api/admin/reports/resolve", {
      token: tokenFor(admin),
      body: { reportId: report.id, status: "RESOLVED", action: "WARN_USER" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const notification = await queryOne(
      "SELECT type FROM notifications WHERE user_id = $1 AND metadata->>'source' IS NULL ORDER BY created_at DESC LIMIT 1",
      [target.id],
      "test:warningNotification",
    );
    assert.equal(notification?.type, "MODERATION");
  });

  it("archives the reported group when REMOVE_GROUP is requested", async () => {
    const fx = await createGroupFixture();
    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, 'GROUP', $2, 'SPAM', 'reported group removal test')
       RETURNING id`,
      [fx.member.id, fx.groupId],
      "test:groupRemovalReport",
    );
    createdReportIds.push(report.id);

    const response = await call("POST", "/api/admin/reports/resolve", {
      token: tokenFor(admin),
      body: { reportId: report.id, status: "RESOLVED", action: "REMOVE_GROUP" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const state = await queryOne(
      `SELECT g.status, w.is_archived, jr.status AS request_status
         FROM study_groups g
         JOIN workspaces w ON w.id = $2
         LEFT JOIN study_group_join_requests jr ON jr.id = $3
        WHERE g.id = $1`,
      [fx.groupId, fx.workspaceId, fx.requestId],
      "test:reportedGroupRemovalState",
    );
    assert.equal(state.status, "ARCHIVED");
    assert.equal(state.is_archived, true);
    assert.equal(state.request_status, "CANCELLED");
  });
});

// ===========================================================================
// L. admin edits revoke sessions and reset verification
// ===========================================================================
describe("L. administrator account changes invalidate sessions", () => {
  it("soft-deletes a non-administrator account and revokes access", async () => {
    const target = await createUser(ROLES.STUDENT, "delete-target");

    const response = await call("DELETE", `/api/admin/users/${target.id}`, {
      token: tokenFor(admin),
      body: { reason: "Account removal integration test" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.deleted, true);

    const state = await queryOne(
      `SELECT u.status, u.deleted_at, s.revoked_at, s.revoked_reason, a.action, a.actor_id
         FROM users u
         JOIN auth_sessions s ON s.user_id = u.id
         LEFT JOIN audit_logs a ON a.entity_type = 'user' AND a.entity_id = u.id::text
                              AND a.action = 'admin.account.deleted'
        WHERE u.id = $1
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [target.id],
      "test:adminDeleteState",
    );
    assert.equal(state.status, "DEACTIVATED");
    assert.ok(state.deleted_at);
    assert.ok(state.revoked_at);
    assert.equal(state.revoked_reason, "admin_delete");
    assert.equal(state.action, "admin.account.deleted");
    assert.equal(state.actor_id, admin.id);
  });

  it("archives groups owned by an account before deleting it", async () => {
    const fx = await createGroupFixture();
    const response = await call("DELETE", `/api/admin/users/${fx.owner.id}`, {
      token: tokenFor(admin),
      body: { reason: "Remove owner and preserve group history" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.groupsArchived, 1);

    const state = await queryOne(
      `SELECT g.status, w.is_archived, jr.status AS request_status,
              m.status AS membership_status, m.left_at
         FROM study_groups g
         LEFT JOIN workspace_groups wg ON wg.group_id = g.id
         LEFT JOIN workspaces w ON w.id = wg.workspace_id
         LEFT JOIN study_group_join_requests jr ON jr.id = $2
         LEFT JOIN study_group_members m ON m.group_id = g.id AND m.student_id = $3
        WHERE g.id = $1`,
      [fx.groupId, fx.requestId, fx.owner.id],
      "test:deleteOwnerGroupState",
    );
    assert.equal(state.status, "ARCHIVED");
    assert.equal(state.is_archived, true);
    assert.equal(state.request_status, "CANCELLED");
    assert.equal(state.membership_status, "DEACTIVATED");
    assert.ok(state.left_at);
  });

  it("revokes sessions on a role change", async () => {
    const target = await createUser(ROLES.STUDENT, "role-edit");
    const response = await call("POST", `/api/admin/users/${target.id}/role`, {
      token: tokenFor(admin),
      body: { role: ROLES.GROUP_LEADER, reason: "role session revocation test" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const session = await queryOne("SELECT revoked_at FROM auth_sessions WHERE id = $1", [target.sessionId], "test:roleSession");
    assert.ok(session.revoked_at);
    const oldToken = await call("GET", "/api/students/me", { token: tokenFor(target) });
    assert.equal(oldToken.status, 401);
  });

  it("resets email verification and revokes sessions on an email change", async () => {
    const target = await createUser(ROLES.STUDENT, "email-edit");
    const nextEmail = tag("email-edit-new");
    const pendingToken = randomUUID();
    await query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'EMAIL_CHANGE', $2, now() + interval '1 hour')`,
      [target.id, pendingToken],
      "test:pendingEmailChangeToken",
    );
    const response = await call("PATCH", `/api/admin/users/${target.id}`, {
      token: tokenFor(admin),
      body: { email: nextEmail },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const user = await queryOne(
      "SELECT email, email_verified_at, status FROM users WHERE id = $1",
      [target.id],
      "test:emailChanged",
    );
    assert.equal(user.email, nextEmail);
    assert.equal(user.email_verified_at, null);
    assert.equal(user.status, "PENDING_VERIFICATION");

    const session = await queryOne("SELECT revoked_at FROM auth_sessions WHERE id = $1", [target.sessionId], "test:emailSession");
    assert.ok(session.revoked_at);
    const invalidatedToken = await queryOne(
      "SELECT consumed_at FROM auth_tokens WHERE token_hash = $1",
      [pendingToken],
      "test:emailChangeTokenConsumed",
    );
    assert.ok(invalidatedToken.consumed_at);
    const oldToken = await call("GET", "/api/students/me", { token: tokenFor(target) });
    assert.equal(oldToken.status, 401);
  });

  it("allows an administrator to update their own profile details", async () => {
    const self = await createUser(ROLES.ADMIN, "self-profile-edit");
    const response = await call("PATCH", `/api/admin/users/${self.id}`, {
      token: tokenFor(self),
      body: { firstName: "Updated", lastName: "Administrator" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.user.first_name, "Updated");
    assert.equal(response.body.data.user.last_name, "Administrator");

    const user = await queryOne(
      "SELECT first_name, last_name FROM users WHERE id = $1",
      [self.id],
      "test:selfProfileEdit",
    );
    assert.equal(user.first_name, "Updated");
    assert.equal(user.last_name, "Administrator");
  });

  it("revokes sessions even when the legacy suspendSessions flag is false", async () => {
    const target = await createUser(ROLES.STUDENT, "suspend-session");
    const response = await call("POST", "/api/admin/users/suspend", {
      token: tokenFor(admin),
      body: { userId: target.id, reason: "session revocation test", suspendSessions: false },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const session = await queryOne("SELECT revoked_at FROM auth_sessions WHERE id = $1", [target.sessionId], "test:suspendSession");
    assert.ok(session.revoked_at);
  });

  it("rejects demoting the last active administrator", async () => {
    const target = await createUser(ROLES.ADMIN, "last-admin-target");
    // The shared test seed contains a demo administrator. Preserve every
    // existing admin's state while making this fixture genuinely represent a
    // platform with only one active administrator: the target under test.
    const otherAdmins = await queryRows(
      `SELECT u.id, u.status, u.email_verified_at
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.key = 'ADMIN' AND u.deleted_at IS NULL AND u.id <> $1`,
      [target.id],
      "test:lastAdminOtherAdmins",
    );
    await query(
      `UPDATE users SET status = 'PENDING_VERIFICATION', email_verified_at = NULL
        WHERE id = ANY($1::uuid[])`,
      [otherAdmins.map((row) => row.id)],
      "test:makeOtherAdminsNonActive",
    );
    await query(
      "UPDATE users SET status = 'PENDING_VERIFICATION' WHERE id = $1",
      [admin.id],
      "test:makeAdminNonActive",
    );

    try {
      const response = await call("POST", `/api/admin/users/${target.id}/role`, {
        token: tokenFor(admin),
        body: { role: ROLES.STUDENT, reason: "last admin protection test" },
      });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      const row = await queryOne(
        `SELECT r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
        [target.id],
        "test:lastAdminRole",
      );
      assert.equal(row.role, ROLES.ADMIN);
    } finally {
      for (const otherAdmin of otherAdmins) {
        await query(
          "UPDATE users SET status = $2, email_verified_at = $3 WHERE id = $1",
          [otherAdmin.id, otherAdmin.status, otherAdmin.email_verified_at],
          "test:restoreOtherAdminState",
        );
      }
    }
  });
});
