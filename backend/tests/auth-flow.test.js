import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression guard for the auth-middleware ordering contract.
 *
 * `requireRole(...)` (and therefore `requireStudent`, `requireStaff`,
 * `requireAdmin`) deliberately does NOT authenticate — it only gates an
 * already-authenticated request. Every router that uses a role gate must
 * therefore register `requireAuth` before its routes, or every write silently
 * fails with 401 "You need to sign in to continue." while reads (which use
 * `requireAuth` per-route) keep working.
 */
import studentsRoutes from "../src/routes/students.routes.js";
import { requireAuth, requireStudent } from "../src/middleware/auth.js";

describe("role-gated routers run requireAuth first", () => {
  it("registers requireAuth at the start of the students router", () => {
    const layers = studentsRoutes.stack.filter((layer) => typeof layer.handle === "function");
    assert.ok(
      layers.length > 0 && layers[0].handle === requireAuth,
      "requireAuth must be the first middleware in the students router so req.user is set before any requireStudent gate",
    );
  });

  it("documents that a role gate is not an authenticator", () => {
    // requireStudent only gates a session; it never establishes one. That is
    // why requireAuth must precede it — otherwise req.user is never populated
    // and the gate rejects everyone with a 401.
    assert.notEqual(requireStudent, requireAuth);
  });
});