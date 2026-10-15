import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Environment — set BEFORE importing the app, because `env.js` validates on
// import and `db.js` opens the pool at import time.
// ---------------------------------------------------------------------------
const RUN = randomUUID().slice(0, 8);

const rawDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  throw new Error("Integration tests require DATABASE_URL or TEST_DATABASE_URL to be set.");
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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || toTestDatabaseUrl(rawDatabaseUrl);
const TEST_AUTH_SECRET = process.env.TEST_AUTH_SECRET || "integration-test-auth-secret-0123456789abcdef";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.AUTH_SECRET = TEST_AUTH_SECRET;
process.env.RATE_LIMIT_MAX = "100000";
process.env.AUTH_RATE_LIMIT_MAX = "100000";
process.env.AI_RATE_LIMIT_MAX = "100000";
process.env.SEARCH_RATE_LIMIT_MAX = "100000";
process.env.WRITE_RATE_LIMIT_MAX = "100000";
process.env.LOG_LEVEL = "silent";

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
  await pool.query("SELECT 1");
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

const createdUserIds = [];
const createdSessionIds = [];
const createdGroupIds = [];

after(async () => {
  for (const sessionId of createdSessionIds) {
    await query("DELETE FROM study_sessions WHERE id = $1", [sessionId], "test:cleanupSession").catch(() => {});
  }
  for (const groupId of createdGroupIds) {
    await query("DELETE FROM study_group_members WHERE group_id = $1", [groupId], "test:cleanupMembers").catch(() => {});
    await query("DELETE FROM study_groups WHERE id = $1", [groupId], "test:cleanupGroup").catch(() => {});
  }
  for (const userId of createdUserIds) {
    await query("DELETE FROM notifications WHERE user_id = $1", [userId], "test:cleanupNotifications").catch(() => {});
    await query("DELETE FROM users WHERE id = $1", [userId], "test:cleanupUser").catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tag = (label) => `sess-${RUN}-${label}@example.test`;

async function createUser(roleKey, label) {
  const role = await queryOne("SELECT id FROM roles WHERE key = $1", [roleKey], "test:role");
  assert.ok(role, `role ${roleKey} must exist (seed the database first)`);

  const id = randomUUID();
  await query(
    `INSERT INTO users (id, email, password_hash, role_id, status, first_name, last_name,
                        email_verified_at, password_changed_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, 'User', now(), now())`,
    [id, tag(label), await hashPassword("Authz!2026test"), role.id, label],
    "test:createUser",
  );
  createdUserIds.push(id);
  const token = signAccessToken({
    userId: id,
    role: roleKey,
    roleId: role.id,
    sessionId: randomUUID(),
    email: tag(label),
    name: label,
  });
  return { id, role: roleKey, token };
}

async function call(method, path, { token, csrf, body } = {}) {
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
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: response.status, body: json };
}

async function getCsrf() {
  const response = await fetch(`${baseUrl}/api/auth/csrf`, { method: "GET" });
  const json = await response.json();
  const token = json?.data?.csrfToken;
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("lien_csrf="));
  const cookie = setCookie?.split(";")[0];
  assert.ok(token && cookie, "csrf endpoint issues a token + cookie");
  return { cookie, token };
}

async function anyCourseId() {
  const row = await queryOne(
    "SELECT id FROM courses WHERE is_active ORDER BY course_code LIMIT 1",
    [],
    "test:course",
  );
  assert.ok(row, "at least one active course must be seeded");
  return row.id;
}

let fixtureCounter = 0;

async function groupFixture() {
  const n = fixtureCounter++;
  const owner = await createUser(ROLES.STUDENT, `owner-${n}`);
  const memberA = await createUser(ROLES.STUDENT, `member-a-${n}`);
  const memberB = await createUser(ROLES.STUDENT, `member-b-${n}`);
  const outsider = await createUser(ROLES.STUDENT, `outsider-${n}`);

  const groupId = randomUUID();
  await query(
    `INSERT INTO study_groups (id, slug, name, course_id, description, mode, privacy, require_approval,
                               min_size, max_size, owner_id, created_by_role)
     VALUES ($1, $2, $3, $4, '', 'EITHER', 'PUBLIC', FALSE, 2, 6, $5, 'STUDENT')`,
    [groupId, `sess-${RUN}-g${n}`, `Sessions ${RUN}-${n}`, await anyCourseId(), owner.id],
    "test:createGroup",
  );
  createdGroupIds.push(groupId);

  for (const [member, role] of [[owner, "OWNER"], [memberA, "MEMBER"], [memberB, "MEMBER"]]) {
    await query(
      `INSERT INTO study_group_members (id, group_id, student_id, role, status, joined_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [randomUUID(), groupId, member.id, role],
      "test:addMember",
    );
  }

  const workspace = await queryOne(
    "SELECT id FROM workspaces WHERE group_id = $1 LIMIT 1",
    [groupId],
    "test:workspace",
  );
  assert.ok(workspace, "group trigger creates a workspace");

  return { owner, memberA, memberB, outsider, groupId, workspaceId: workspace.id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("study sessions — API", () => {
  it("lists sessions a student can see through group membership", async () => {
    const { owner } = await groupFixture();
    const { status, body } = await call("GET", "/api/sessions", { token: owner.token });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data.sessions));
  });

  it("guarded read: a non-member cannot open a session", async () => {
    const fx = await groupFixture();

    const created = await call("POST", "/api/sessions", {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {
        workspaceId: fx.workspaceId,
        title: "Private check-in",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        format: "FLEXIBLE",
        mode: "ONLINE",
        meetingUrl: "https://meet.example/private",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sessionId = created.body.data.session.id;
    createdSessionIds.push(sessionId);

    const { status, body } = await call("GET", `/api/sessions/${sessionId}`, { token: fx.outsider.token });
    assert.equal(status, 403);
    assert.equal(body.error.code, "FORBIDDEN");
  });

  it("guided session comes with a starter agenda and closed participant list", async () => {
    const fx = await groupFixture();

    const created = await call("POST", "/api/sessions", {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {
        workspaceId: fx.workspaceId,
        title: "Guided session",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        format: "GUIDED",
        mode: "ONLINE",
        meetingRoom: "verification-room",
        participantIds: [fx.memberA.id, fx.memberB.id],
        participantsClosed: true,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sessionId = created.body.data.session.id;
    createdSessionIds.push(sessionId);

    assert.equal(created.body.data.session.format, "GUIDED");
    assert.equal(created.body.data.session.participants_closed, true);
    assert.equal(created.body.data.session.agenda.length, 8);
    assert.equal(created.body.data.session.participants.length, 3);

    // Invited members can read the collaboration detail.
    const detail = await call("GET", `/api/sessions/${sessionId}`, { token: fx.memberA.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.session.isParticipant, true);
  });

  it("lifecycle: start -> pause -> resume -> complete", async () => {
    const fx = await groupFixture();

    const created = await call("POST", "/api/sessions", {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {
        workspaceId: fx.workspaceId,
        title: "Lifecycle",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        mode: "ONLINE",
        meetingUrl: "https://meet.example/lifecycle",
      },
    });
    const sessionId = created.body.data.session.id;
    createdSessionIds.push(sessionId);

    const start = await call("POST", `/api/sessions/${sessionId}/start`, { token: fx.owner.token, csrf: await getCsrf() });
    assert.equal(start.status, 200);
    assert.equal(start.body.data.session.status, "ACTIVE");

    const dup = await call("POST", `/api/sessions/${sessionId}/start`, { token: fx.owner.token, csrf: await getCsrf() });
    assert.equal(dup.status, 409);

    // A plain member cannot start/pause.
    const denied = await call("POST", `/api/sessions/${sessionId}/pause`, { token: fx.memberA.token, csrf: await getCsrf() });
    assert.equal(denied.status, 403);

    const pause = await call("POST", `/api/sessions/${sessionId}/pause`, { token: fx.owner.token, csrf: await getCsrf() });
    assert.equal(pause.body.data.session.status, "PAUSED");

    const resume = await call("POST", `/api/sessions/${sessionId}/resume`, { token: fx.owner.token, csrf: await getCsrf() });
    assert.equal(resume.body.data.session.status, "ACTIVE");

    const complete = await call("POST", `/api/sessions/${sessionId}/complete`, { token: fx.owner.token, csrf: await getCsrf() });
    assert.equal(complete.body.data.session.status, "COMPLETED");
  });

  it("role rotation assigns three distinct holders for the round", async () => {
    const fx = await groupFixture();

    const created = await call("POST", "/api/sessions", {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {
        workspaceId: fx.workspaceId,
        title: "Rotation",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        format: "GUIDED",
        mode: "ONLINE",
        meetingUrl: "https://meet.example/rotation",
      },
    });
    const sessionId = created.body.data.session.id;
    createdSessionIds.push(sessionId);

    const rotated = await call("POST", `/api/sessions/${sessionId}/roles/rotate`, {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {},
    });
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
    const roles = rotated.body.data.roles;

    const holders = new Set(roles.map((r) => r.student_id));
    assert.equal(roles.length, 3);
    assert.equal(holders.size, 3);
  });

  it("chat, question queue and notes are participant-scoped and versioned", async () => {
    const fx = await groupFixture();

    const created = await call("POST", "/api/sessions", {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {
        workspaceId: fx.workspaceId,
        title: "Collab",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        mode: "ONLINE",
        meetingUrl: "https://meet.example/collab",
      },
    });
    const sessionId = created.body.data.session.id;
    createdSessionIds.push(sessionId);

    const msg = await call("POST", `/api/sessions/${sessionId}/messages`, {
      token: fx.memberA.token,
      csrf: await getCsrf(),
      body: { body: "hello session", clientId: `sess-${RUN}-msg1` },
    });
    assert.equal(msg.status, 201);
    assert.equal(msg.body.data.message.author_id, fx.memberA.id);

    const q = await call("POST", `/api/sessions/${sessionId}/questions`, {
      token: fx.memberA.token,
      csrf: await getCsrf(),
      body: { topic: "Notes", body: "Can everyone edit notes?" },
    });
    assert.equal(q.status, 201);
    assert.equal(q.body.data.question.status, "OPEN");

    const note = await call("POST", `/api/sessions/${sessionId}/notes`, {
      token: fx.memberA.token,
      csrf: await getCsrf(),
      body: { title: "Shared doc", body: "v1" },
    });
    assert.equal(note.status, 201);
    assert.equal(note.body.data.note.version, 1);

    const update = await call("PUT", `/api/sessions/${sessionId}/notes/${note.body.data.note.id}`, {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: { title: "Shared doc", body: "v2", version: 1 },
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.data.note.version, 2);

    const stale = await call("PUT", `/api/sessions/${sessionId}/notes/${note.body.data.note.id}`, {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: { title: "Shared doc", body: "stale v1 again", version: 1 },
    });
    assert.equal(stale.status, 409, "a stale version is rejected");
  });

  it("meeting tokens are refused when LiveKit is not configured", async () => {
    const fx = await groupFixture();

    const created = await call("POST", "/api/sessions", {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {
        workspaceId: fx.workspaceId,
        title: "Meeting",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        mode: "ONLINE",
        meetingUrl: "https://meet.example/meeting",
      },
    });
    const sessionId = created.body.data.session.id;
    createdSessionIds.push(sessionId);

    await call("POST", `/api/sessions/${sessionId}/start`, { token: fx.owner.token, csrf: await getCsrf() });

    const { status, body } = await call("POST", `/api/sessions/${sessionId}/meeting/token`, {
      token: fx.owner.token,
      csrf: await getCsrf(),
      body: {},
    });
    assert.equal(status, 503);
    assert.equal(body.error.code, "MEETING_NOT_CONFIGURED");
  });
});