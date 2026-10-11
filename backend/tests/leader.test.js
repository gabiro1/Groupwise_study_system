import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  leaderGroupFilterSchema,
  leaderSessionQuerySchema,
  cancelInvitationParamSchema,
  announcementSchema,
  analyticsQuerySchema,
  recommendMembersQuerySchema,
} from "../src/lib/schemas.js";
import studyGroupsRoutes from "../src/routes/studyGroups.routes.js";
import { requireAuth } from "../src/middleware/auth.js";
import * as leader from "../src/services/leader.service.js";

const GROUP_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const INVITATION_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e";

describe("leader schemas", () => {
  it("accepts an empty filter and an optional group", () => {
    assert.deepEqual(leaderGroupFilterSchema.parse({}), {});
    assert.equal(leaderGroupFilterSchema.parse({ groupId: GROUP_ID }).groupId, GROUP_ID);
    assert.equal(leaderGroupFilterSchema.safeParse({ groupId: "nope" }).success, false);
  });

  it("defaults leader session queries to upcoming", () => {
    const parsed = leaderSessionQuerySchema.parse({});
    assert.equal(parsed.scope, "upcoming");
    assert.equal(parsed.limit, 20);
    assert.equal(leaderSessionQuerySchema.parse({ scope: "past" }).scope, "past");
    assert.equal(leaderSessionQuerySchema.safeParse({ scope: "next" }).success, false);
  });

  it("requires group and invitation ids to cancel", () => {
    assert.equal(
      cancelInvitationParamSchema.safeParse({ groupId: GROUP_ID, invitationId: INVITATION_ID }).success,
      true,
    );
    assert.equal(cancelInvitationParamSchema.safeParse({ groupId: GROUP_ID }).success, false);
  });

  it("bounds announcements", () => {
    assert.equal(announcementSchema.safeParse({ title: "Exam move", body: "Room 4 at 6pm." }).success, true);
    assert.equal(announcementSchema.safeParse({ title: "", body: "x" }).success, false);
    assert.equal(announcementSchema.safeParse({ title: "Ok", body: "" }).success, false);
    assert.equal(announcementSchema.safeParse({ title: "t".repeat(141), body: "x" }).success, false);
  });

  it("bounds the analytics window", () => {
    assert.equal(analyticsQuerySchema.parse({}).days, 30);
    assert.equal(analyticsQuerySchema.parse({ days: "7" }).days, 7);
    assert.equal(analyticsQuerySchema.safeParse({ days: 0 }).success, false);
    assert.equal(analyticsQuerySchema.safeParse({ days: 400 }).success, false);
  });

  it("defaults recommended-member paging", () => {
    const parsed = recommendMembersQuerySchema.parse({});
    assert.equal(parsed.limit, 12);
    assert.equal(recommendMembersQuerySchema.safeParse({ limit: 0 }).success, false);
  });
});

describe("leader service surface", () => {
  it("exposes every leader operation used by the routes", () => {
    const operations = [
      "managedGroupIds",
      "listPendingRequests",
      "listPendingInvitations",
      "cancelInvitation",
      "listLeaderSessions",
      "groupAnalytics",
      "recommendMembers",
      "postAnnouncement",
    ];
    for (const name of operations) {
      assert.equal(typeof leader[name], "function", `${name} must be exported`);
    }
  });
});

describe("study group router guard order", () => {
  it("registers requireAuth before any leader route", () => {
    const layers = studyGroupsRoutes.stack.filter((layer) => typeof layer.handle === "function");
    assert.ok(
      layers.length > 0 && layers[0].handle === requireAuth,
      "requireAuth must be the first middleware so leader routes resolve a caller",
    );
  });
});
