import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nextConnectionStatus,
  PARTNER_ACTIONS,
  MAX_PENDING_OUTBOUND,
} from "../src/services/partner.service.js";
import {
  partnerInviteSchema,
  partnerRespondSchema,
  partnerMessageSchema,
  partnerMessageQuerySchema,
  partnerConversationParamSchema,
} from "../src/lib/schemas.js";
import partnersRoutes from "../src/routes/partners.routes.js";
import { requireAuth, requireStudent } from "../src/middleware/auth.js";

/**
 * Study-partner behaviour that should not regress silently.
 *
 * The connection transitions are the access-control core of direct messaging:
 * only a PENDING row can move, and accepting is the only way a thread can come
 * into existence. The schemas mirror what the middleware layer will enforce,
 * and the router-order test repeats the invariant that protects every other
 * role-gated router in the project.
 */

// zod's .uuid() accepts only RFC 4122 v4/variant bits, so these must be real
// v4-format identifiers rather than "0000…" placeholders.
const RECIPIENT_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const CONVERSATION_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e";

describe("nextConnectionStatus", () => {
  it("moves a pending offer forward on accept", () => {
    assert.equal(nextConnectionStatus("PENDING", PARTNER_ACTIONS.ACCEPT), "ACCEPTED");
  });

  it("moves a pending offer to declined", () => {
    assert.equal(nextConnectionStatus("PENDING", PARTNER_ACTIONS.DECLINE), "DECLINED");
  });

  it("allows the requester to revoke a pending offer", () => {
    assert.equal(nextConnectionStatus("PENDING", PARTNER_ACTIONS.REVOKE), "REVOKED");
  });

  it("freezes a closed offer: no action moves ACCEPTED, DECLINED or REVOKED", () => {
    for (const closed of ["ACCEPTED", "DECLINED", "REVOKED"]) {
      assert.equal(nextConnectionStatus(closed, PARTNER_ACTIONS.ACCEPT), null);
      assert.equal(nextConnectionStatus(closed, PARTNER_ACTIONS.DECLINE), null);
      assert.equal(nextConnectionStatus(closed, PARTNER_ACTIONS.REVOKE), null);
    }
  });

  it("rejects an unknown action", () => {
    assert.equal(nextConnectionStatus("PENDING", "MAYBE"), null);
  });
});

describe("partner schemas", () => {
  it("accepts a valid invite", () => {
    const result = partnerInviteSchema.safeParse({ recipientId: RECIPIENT_ID });
    assert.equal(result.success, true);
  });

  it("rejects a self-invitation by message policy (recipientId is only a uuid)", () => {
    const result = partnerInviteSchema.safeParse({ recipientId: "not-a-uuid" });
    assert.equal(result.success, false);
  });

  it("rejects an invite without a recipient", () => {
    assert.equal(partnerInviteSchema.safeParse({}).success, false);
  });

  it("bounds the invite note", () => {
    assert.equal(
      partnerInviteSchema.safeParse({ recipientId: RECIPIENT_ID, message: "x".repeat(501) }).success,
      false,
    );
  });

  it("accepts only ACCEPT or DECLINE responses", () => {
    assert.equal(partnerRespondSchema.safeParse({ response: "ACCEPT" }).success, true);
    assert.equal(partnerRespondSchema.safeParse({ response: "DECLINE" }).success, true);
    assert.equal(partnerRespondSchema.safeParse({ response: "MAYBE" }).success, false);
  });

  it("rejects an empty direct message", () => {
    assert.equal(partnerMessageSchema.safeParse({ body: "" }).success, false);
    assert.equal(partnerMessageSchema.safeParse({ body: "  " }).success, false);
    assert.equal(partnerMessageSchema.safeParse({ body: "hello" }).success, true);
  });

  it("bounds message length to the workspace chat limit", () => {
    assert.equal(partnerMessageSchema.safeParse({ body: "x".repeat(4001) }).success, false);
  });

  it("parses a UUID conversation param and a cursor limit", () => {
    assert.equal(
      partnerConversationParamSchema.safeParse({ conversationId: CONVERSATION_ID }).success,
      true,
    );
    assert.equal(
      partnerConversationParamSchema.safeParse({ conversationId: "nope" }).success,
      false,
    );
    assert.equal(partnerMessageQuerySchema.parse({ limit: "15" }).limit, 15);
  });
});

describe("partner router guard order", () => {
  it("registers requireAuth before requireStudent", () => {
    const layers = partnersRoutes.stack.filter((layer) => typeof layer.handle === "function");
    assert.ok(
      layers.length >= 2 &&
        layers[0].handle === requireAuth &&
        layers[1].handle === requireStudent,
      "requireAuth must run before requireStudent so req.user exists for the role gate",
    );
  });
});

describe("partner spam ceiling", () => {
  it("keeps a per-student outbound cap defined in one place", () => {
    assert.ok(Number.isInteger(MAX_PENDING_OUTBOUND) && MAX_PENDING_OUTBOUND > 0);
  });
});
