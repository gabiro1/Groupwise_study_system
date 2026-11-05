import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REPORT_ACTION_TARGETS,
  assertReportActionTarget,
  assertReportResolution,
  isReportActionTargetCompatible,
} from "../src/lib/reportModeration.js";
import { sanitiseMetadata } from "../src/lib/audit.js";
import { redact } from "../src/config/logger.js";
import { adminUserQuerySchema } from "../src/lib/schemas.js";

describe("report moderation action matrix", () => {
  it("allows only actions that match the reported target", () => {
    for (const [action, targets] of Object.entries(REPORT_ACTION_TARGETS)) {
      for (const target of ["STUDENT", "GROUP", "MESSAGE", "RESOURCE"]) {
        assert.equal(isReportActionTargetCompatible(action, target), targets.includes(target));
        if (targets.includes(target)) assert.doesNotThrow(() => assertReportActionTarget(action, target));
        else {
          assert.throws(
            () => assertReportActionTarget(action, target),
            (error) => error.code === "INVALID_REPORT_ACTION_TARGET" && error.status === 422,
          );
        }
      }
    }
  });

  it("never includes an administrator-only target or a deactivation action", () => {
    assert.deepEqual(REPORT_ACTION_TARGETS.SUSPEND_USER, ["STUDENT"]);
    assert.equal(REPORT_ACTION_TARGETS.DEACTIVATE_USER, undefined);
  });

  it("does not apply a moderation action while leaving the report open", () => {
    assert.doesNotThrow(() => assertReportResolution("RESOLVED", "REMOVE_CONTENT"));
    assert.doesNotThrow(() => assertReportResolution("DISMISSED", "NONE"));
    assert.throws(
      () => assertReportResolution("IN_REVIEW", "SUSPEND_USER"),
      (error) => error.code === "INVALID_REPORT_RESOLUTION" && error.status === 422,
    );
    assert.throws(
      () => assertReportResolution("DISMISSED", "REMOVE_GROUP"),
      (error) => error.code === "INVALID_REPORT_RESOLUTION" && error.status === 422,
    );
  });
});

describe("audit metadata sanitisation", () => {
  it("removes sensitive keys recursively from objects and arrays", () => {
    const circular = { safe: "kept" };
    circular.self = circular;

    const result = sanitiseMetadata({
      safe: "kept",
      password: "top-level",
      nested: {
        api_key: "nested-key",
        clientSecret: "nested-secret",
        safe: "nested-kept",
        values: [{ refreshToken: "refresh-secret", value: "kept" }],
      },
      circular,
    });

    assert.equal(result.safe, "kept");
    assert.equal(result.password, undefined);
    assert.equal(result.nested.api_key, undefined);
    assert.equal(result.nested.clientSecret, undefined);
    assert.equal(result.nested.safe, "nested-kept");
    assert.equal(result.nested.values[0].refreshToken, undefined);
    assert.equal(result.nested.values[0].value, "kept");
    assert.equal(result.circular.self, "[circular]");
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  it("redacts sensitive log keys recursively without leaking casing variants", () => {
    const result = redact({
      nested: { resetToken: "reset-secret", api_key: "api-secret", safe: "kept" },
      clientSecret: "client-secret",
    });

    assert.equal(result.nested.resetToken, "[redacted]");
    assert.equal(result.nested.api_key, "[redacted]");
    assert.equal(result.clientSecret, "[redacted]");
    assert.equal(result.nested.safe, "kept");
  });
});

describe("admin user pagination validation", () => {
  it("coerces numeric cursors and rejects invalid offsets", () => {
    assert.equal(adminUserQuerySchema.parse({ cursor: "25" }).cursor, 25);
    assert.throws(() => adminUserQuerySchema.parse({ cursor: "not-a-number" }));
    assert.throws(() => adminUserQuerySchema.parse({ cursor: "-1" }));
  });
});
