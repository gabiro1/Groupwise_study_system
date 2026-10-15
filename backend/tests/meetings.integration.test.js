import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const RUN = randomUUID().slice(0, 8);
const rawDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!rawDatabaseUrl) throw new Error("Integration tests require DATABASE_URL to be set.");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = rawDatabaseUrl;
process.env.AUTH_SECRET = process.env.TEST_AUTH_SECRET || "integration-test-auth-secret-0123456789abcdef";
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
const createdGroupIds = [];
const createdMeetingIds = [];
after(async () => {
  for (const id of createdMeetingIds) {
    await query("DELETE FROM group_meetings WHERE id = $1", [id], "t:cm").catch(() => {});
  }
  for (const groupId of createdGroupIds) {
    await query("DELETE FROM study_group_members WHERE group_id = $1", [groupId], "t:cm2").catch(() => {});
    await query("DELETE FROM study_groups WHERE id = $1", [groupId], "t:cg").catch(() => {});
  }
  for (const userId of createdUserIds) {
    await query("DELETE FROM notifications WHERE user_id = $1", [userId], "t:cn").catch(() => {});
    await query("DELETE FROM users WHERE id = $1", [userId], "t:cu").catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
});

const tag = (label) => `meet-${RUN}-${label}@example.test`;
async function createUser(label) {
  const role = await queryOne("SELECT id FROM roles WHERE key = $1", ["STUDENT"], "t:role");
  assert.ok(role, "STUDENT role must exist");
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, email, password_hash, role_id, status, first_name, last_name,
                        email_verified_at, password_changed_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, 'User', now(), now())`,
    [id, tag(label), await hashPassword("Meet!2026test"), role.id, label], "t:cu2",
  );
  createdUserIds.push(id);
  const token = signAccessToken({
    userId: id, role: "STUDENT", roleId: role.id,
    sessionId: randomUUID(), email: tag(label), name: label,
  });
  return { id, token };
}
async function createGroup(ownerId, name) {
  const course = await queryOne("SELECT id FROM courses LIMIT 1", [], "t:course");
  assert.ok(course, "courses seed required");
  const id = randomUUID();
  await query(
    `INSERT INTO study_groups (id, slug, name, course_id, owner_id, privacy, status)
     VALUES ($1, $2, $3, $4, $5, 'REQUEST_REQUIRED', 'ACTIVE')`,
    [id, `meet-${RUN}-${randomUUID().slice(0, 6)}`, name, course.id, ownerId], "t:cg2",
  );
  await query(
    `INSERT INTO study_group_members (group_id, student_id, role, status)
     VALUES ($1, $2, 'OWNER', 'ACTIVE') ON CONFLICT DO NOTHING`,
    [id, ownerId], "t:co",
  );
  createdGroupIds.push(id);
  return id;
}
async function addMember(groupId, userId, role = "MEMBER") {
  await query(
    `INSERT INTO study_group_members (group_id, student_id, role, status)
     VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT DO NOTHING`,
    [groupId, userId, role], "t:am",
  );
}
async function call(method, path, opts = {}) {
  const headers = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const futureISO = (mins) => new Date(Date.now() + mins * 60 * 1000).toISOString();
describe("video meetings — scheduling and permissions", () => {
  it("leader schedules; members list and view", async () => {
    const leader = await createUser("Leader");
    const member = await createUser("Member");
    const groupId = await createGroup(leader.id, "Meeting Group A");
    await addMember(groupId, member.id);
    const created = await call("POST", "/api/meetings", {
      token: leader.token,
      body: {
        groupId, title: "Calculus review call", description: "Chapter 4 walkthrough",
        scheduledStart: futureISO(120), expectedDurationMinutes: 60,
      },
    });
    assert.equal(created.status, 201);
    const meeting = created.data.data.meeting;
    assert.ok(meeting.id);
    assert.equal(meeting.status, "SCHEDULED");
    assert.ok(meeting.provider_room_identifier);
    createdMeetingIds.push(meeting.id);
    const list = await call("GET", `/api/meetings/group/${groupId}`, { token: member.token });
    assert.equal(list.status, 200);
    assert.ok(list.data.data.meetings.some((m) => m.id === meeting.id));
    const detail = await call("GET", `/api/meetings/${meeting.id}`, { token: member.token });
    assert.equal(detail.status, 200);
  });

  it("rejects invalid input", async () => {
    const leader = await createUser("BadInput");
    const groupId = await createGroup(leader.id, "Meeting Group B");
    const missing = await call("POST", "/api/meetings", { token: leader.token, body: { groupId } });
    assert.ok([400, 422].includes(missing.status), `got ${missing.status}`);
    const badDuration = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "x", scheduledStart: futureISO(60), expectedDurationMinutes: 9999 },
    });
    assert.ok([400, 422].includes(badDuration.status));
    const past = await call("POST", "/api/meetings", {
      token: leader.token,
      body: {
        groupId, title: "Past meeting",
        scheduledStart: new Date(Date.now() - 3600e3).toISOString(), expectedDurationMinutes: 30,
      },
    });
    assert.ok([400, 422].includes(past.status));
  });

  it("requires auth and membership", async () => {
    const leader = await createUser("AuthLead");
    const outsider = await createUser("Outsider");
    const groupId = await createGroup(leader.id, "Meeting Group C");
    const created = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "Private call", scheduledStart: futureISO(180), expectedDurationMinutes: 30 },
    });
    assert.equal(created.status, 201);
    createdMeetingIds.push(created.data.data.meeting.id);
    const id = created.data.data.meeting.id;
    assert.equal((await call("GET", `/api/meetings/${id}`)).status, 401);
    assert.ok([403, 404].includes((await call("GET", `/api/meetings/${id}`, { token: outsider.token })).status));
    assert.ok([403, 404].includes((await call("GET", `/api/meetings/group/${groupId}`, { token: outsider.token })).status));
  });

  it("members cannot manage; leaders can edit and cancel", async () => {
    const leader = await createUser("PermLead");
    const member = await createUser("PermMember");
    const groupId = await createGroup(leader.id, "Meeting Group D");
    await addMember(groupId, member.id);
    const forbidden = await call("POST", "/api/meetings", {
      token: member.token,
      body: { groupId, title: "Sneaky meeting", scheduledStart: futureISO(240), expectedDurationMinutes: 30 },
    });
    assert.equal(forbidden.status, 403);
    const created = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "Leader meeting", scheduledStart: futureISO(300), expectedDurationMinutes: 45 },
    });
    assert.equal(created.status, 201);
    const id = created.data.data.meeting.id;
    createdMeetingIds.push(id);
    assert.equal((await call("PATCH", `/api/meetings/${id}`, { token: member.token, body: { title: "Hijacked" } })).status, 403);
    const edited = await call("PATCH", `/api/meetings/${id}`, { token: leader.token, body: { title: "Renamed" } });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.data.meeting.title, "Renamed");
    assert.equal((await call("POST", `/api/meetings/${id}/cancel`, { token: member.token })).status, 403);
    assert.equal((await call("POST", `/api/meetings/${id}/cancel`, { token: leader.token })).status, 200);
    const joinCancelled = await call("POST", `/api/meetings/${id}/join`, { token: member.token });
    assert.ok([403, 409].includes(joinCancelled.status));
  });
});
describe("video meetings — lifecycle, join, attendance", () => {
  it("enforces valid state transitions", async () => {
    const leader = await createUser("StateLead");
    const groupId = await createGroup(leader.id, "Meeting Group E");
    const created = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "State machine", scheduledStart: futureISO(400), expectedDurationMinutes: 30 },
    });
    assert.equal(created.status, 201);
    const id = created.data.data.meeting.id;
    createdMeetingIds.push(id);
    assert.equal((await call("POST", `/api/meetings/${id}/complete`, { token: leader.token })).status, 409);
    const started = await call("POST", `/api/meetings/${id}/start`, { token: leader.token });
    assert.equal(started.status, 200);
    assert.equal(started.data.data.meeting.status, "LIVE");
    const done = await call("POST", `/api/meetings/${id}/complete`, { token: leader.token });
    assert.equal(done.status, 200);
    assert.equal(done.data.data.meeting.status, "COMPLETED");
    assert.equal((await call("POST", `/api/meetings/${id}/cancel`, { token: leader.token })).status, 409);
  });

  it("join + idempotent attendance; no secret leak", async () => {
    const leader = await createUser("JoinLead");
    const member = await createUser("JoinMember");
    const groupId = await createGroup(leader.id, "Meeting Group F");
    await addMember(groupId, member.id);
    const created = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "Join window", scheduledStart: futureISO(10), expectedDurationMinutes: 60 },
    });
    assert.equal(created.status, 201);
    const id = created.data.data.meeting.id;
    createdMeetingIds.push(id);
    const joined = await call("POST", `/api/meetings/${id}/join`, { token: member.token });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.data.joinConfig.provider, "JITSI");
    assert.ok(joined.data.data.joinConfig.domain);
    assert.ok(joined.data.data.joinConfig.roomName);
    const flat = JSON.stringify(joined.data.data.joinConfig).toLowerCase();
    assert.ok(!flat.includes("secret"), "join config must not contain secrets");
    assert.equal((await call("POST", `/api/meetings/${id}/attendance/join`, { token: member.token })).data.data.duplicate, false);
    assert.equal((await call("POST", `/api/meetings/${id}/attendance/join`, { token: member.token })).data.data.duplicate, true);
    assert.equal((await call("POST", `/api/meetings/${id}/attendance/leave`, { token: member.token })).data.data.duplicate, false);
    assert.equal((await call("POST", `/api/meetings/${id}/attendance/leave`, { token: member.token })).data.data.duplicate, true);
    const attList = await call("GET", `/api/meetings/${id}/attendance`, { token: leader.token });
    assert.equal(attList.status, 200);
    assert.ok(Array.isArray(attList.data.data.attendance));
    assert.equal((await call("GET", `/api/meetings/${id}/attendance`, { token: member.token })).status, 403);
  });

  it("rejects overlapping meetings with 409", async () => {
    const leader = await createUser("OverlapLead");
    const groupId = await createGroup(leader.id, "Meeting Group G");
    const start = futureISO(500);
    const first = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "First slot", scheduledStart: start, expectedDurationMinutes: 60 },
    });
    assert.equal(first.status, 201);
    createdMeetingIds.push(first.data.data.meeting.id);
    assert.equal((await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "Overlap slot", scheduledStart: start, expectedDurationMinutes: 30 },
    })).status, 409);
  });

  it("provider config exposes only non-secret values", async () => {
    const { buildJoinConfig } = await import("../src/services/videoProvider.service.js");
    const cfg = buildJoinConfig({
      meeting: { provider: "JITSI", provider_room_identifier: "twigane-abc" },
      user: { first_name: "A", last_name: "B", email: "a@b.c" },
      role: "MEMBER",
    });
    assert.equal(cfg.provider, "JITSI");
    assert.ok(cfg.domain && cfg.roomName);
    assert.ok(!("secret" in cfg) && !("jwt" in cfg) && !("token" in cfg));
  });

  it("google meet provider: stores leader-supplied link, join returns it", async () => {
    const leader = await createUser("GmeetLead");
    const member = await createUser("GmeetMember");
    const groupId = await createGroup(leader.id, "Meeting Group H");
    await addMember(groupId, member.id);

    // A GOOGLE_MEET meeting without a link is rejected up front.
    const missing = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "No link", scheduledStart: futureISO(30), expectedDurationMinutes: 45, provider: "GOOGLE_MEET" },
    });
    assert.equal(missing.status, 422);

    // Non-Meet URLs are never stored — a meeting must not point members elsewhere.
    const badUrl = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "Evil link", scheduledStart: futureISO(30), expectedDurationMinutes: 45, provider: "GOOGLE_MEET", joinUrl: "https://evil.example.com/abc-defg-hij" },
    });
    assert.equal(badUrl.status, 422);

    const created = await call("POST", "/api/meetings", {
      token: leader.token,
      body: {
        groupId, title: "Gmeet session", scheduledStart: futureISO(10), expectedDurationMinutes: 45,
        provider: "GOOGLE_MEET", joinUrl: "https://meet.google.com/abc-defg-hij",
      },
    });
    assert.equal(created.status, 201);
    const id = created.data.data.meeting.id;
    createdMeetingIds.push(id);
    assert.equal(created.data.data.meeting.provider, "GOOGLE_MEET");
    assert.equal(created.data.data.meeting.join_url, "https://meet.google.com/abc-defg-hij");
    assert.ok(created.data.data.meeting.provider_room_identifier, "internal room identity is still generated");

    // Members get the link back from join — and nothing else.
    const joined = await call("POST", `/api/meetings/${id}/join`, { token: member.token });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.data.joinConfig.provider, "GOOGLE_MEET");
    assert.equal(joined.data.data.joinConfig.joinUrl, "https://meet.google.com/abc-defg-hij");
    assert.ok(joined.data.data.joinConfig.delegated);
    assert.ok(!("roomName" in joined.data.data.joinConfig), "no Jitsi room leaks for a Meet meeting");
    const flat = JSON.stringify(joined.data.data.joinConfig).toLowerCase();
    assert.ok(!flat.includes("secret"));

    // Leaders can refresh the link; members cannot and non-Meet meetings refuse it.
    const patched = await call("PATCH", `/api/meetings/${id}`, {
      token: leader.token, body: { joinUrl: "https://meet.google.com/xyz-wxyz-uvw/" },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.data.meeting.join_url, "https://meet.google.com/xyz-wxyz-uvw");
    assert.equal((await call("PATCH", `/api/meetings/${id}`, { token: member.token, body: { joinUrl: "https://meet.google.com/aaa-bbbb-ccc" } })).status, 403);

    const jitsiMeeting = await call("POST", "/api/meetings", {
      token: leader.token,
      body: { groupId, title: "Jitsi slot", scheduledStart: futureISO(400), expectedDurationMinutes: 30 },
    });
    assert.equal(jitsiMeeting.status, 201);
    createdMeetingIds.push(jitsiMeeting.data.data.meeting.id);
    assert.equal(
      (await call("PATCH", `/api/meetings/${jitsiMeeting.data.data.meeting.id}`, { token: leader.token, body: { joinUrl: "https://meet.google.com/aaa-bbbb-ccc" } })).status,
      422,
    );
  });

  it("google meet url normalisation rejects anything but a room-code link", async () => {
    const { normalizeGoogleMeetUrl } = await import("../src/services/videoProvider.service.js");
    assert.equal(normalizeGoogleMeetUrl("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
    assert.equal(normalizeGoogleMeetUrl("https://meet.google.com/abc-defg-hij/"), "https://meet.google.com/abc-defg-hij");
    assert.equal(normalizeGoogleMeetUrl("https://meet.google.com/lookup/abc"), null);
    assert.equal(normalizeGoogleMeetUrl("http://meet.google.com/abc-defg-hij"), null);
    assert.equal(normalizeGoogleMeetUrl("https://meet.google.com.evil.test/abc-defg-hij"), null);
    assert.equal(normalizeGoogleMeetUrl("https://evil.test/abc-defg-hij"), null);
    assert.equal(normalizeGoogleMeetUrl(""), null);
    assert.equal(normalizeGoogleMeetUrl(undefined), null);
  });
});
