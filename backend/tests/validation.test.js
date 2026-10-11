import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  z,
  booleanFromQuery,
  optionalBooleanFromQuery,
  groupSearchSchema,
  taskQuerySchema,
  resourceQuerySchema,
  updateSessionSchema,
  createGroupSchema,
  recommendationRequestSchema,
  registerSchema,
  resendVerificationSchema,
} from "../src/lib/schemas.js";

/** Mirrors the inline query schema on GET /api/notifications. */
const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
  unreadOnly: optionalBooleanFromQuery,
});

/**
 * These cover validation behaviour that is invisible when it is wrong.
 *
 * A boolean filter that inverts returns a plausible, non-empty list, so nothing
 * upstream complains: `?overdue=false` simply quietly returned only overdue
 * tasks. `z.coerce.boolean()` caused exactly that, because every non-empty
 * string - including "false" - is truthy in JavaScript.
 */
describe("query booleans", () => {
  it("parses the string spellings a browser sends", () => {
    assert.equal(booleanFromQuery.parse("true"), true);
    assert.equal(booleanFromQuery.parse("1"), true);
    assert.equal(booleanFromQuery.parse("false"), false);
    assert.equal(booleanFromQuery.parse("0"), false);
  });

  it("accepts real booleans for direct service calls", () => {
    assert.equal(booleanFromQuery.parse(true), true);
    assert.equal(booleanFromQuery.parse(false), false);
  });

  it('never treats the string "false" as true', () => {
    // The regression that motivated the helper.
    assert.equal(booleanFromQuery.parse("false"), false);
    assert.notEqual(booleanFromQuery.parse("false"), true);
  });

  it("rejects unparseable values instead of guessing", () => {
    for (const value of ["", "TRUE", "False", "yes", "no", "on", "off", "  "]) {
      assert.equal(
        booleanFromQuery.safeParse(value).success,
        false,
        `expected ${JSON.stringify(value)} to be rejected`,
      );
    }
  });

  it("distinguishes absent from false", () => {
    assert.equal(optionalBooleanFromQuery.parse(undefined), undefined);
    assert.equal(optionalBooleanFromQuery.default(false).parse(undefined), false);
  });
});

describe("verification resend request", () => {
  it("normalizes and validates the account email", () => {
    assert.deepEqual(
      resendVerificationSchema.parse({ email: "  Student@Example.com  " }),
      { email: "student@example.com" },
    );
  });

  it("rejects malformed email addresses", () => {
    assert.equal(resendVerificationSchema.safeParse({ email: "not-an-email" }).success, false);
  });
});

describe("filters using query booleans", () => {
  it("honours group search hasSpace=false", () => {
    const parsed = groupSearchSchema.parse({ hasSpace: "false" });
    assert.equal(parsed.hasSpace, false);
  });

  it("honours task overdue=false and mine=false", () => {
    const parsed = taskQuerySchema.parse({ overdue: "false", mine: "false" });
    assert.equal(parsed.overdue, false);
    assert.equal(parsed.mine, false);
  });

  it("honours unreadOnly=false", () => {
    const parsed = notificationsQuerySchema.parse({ unreadOnly: "false" });
    assert.equal(parsed.unreadOnly, false);
  });

  it("leaves an absent filter absent rather than defaulting it on", () => {
    // A filter that defaults to `true` silently hides rows the caller wanted.
    assert.equal(groupSearchSchema.parse({}).hasSpace, undefined);
    assert.equal(taskQuerySchema.parse({}).overdue, undefined);
    assert.equal(taskQuerySchema.parse({}).mine, undefined);
    assert.equal(notificationsQuerySchema.parse({}).unreadOnly, undefined);
  });

  it("still defaults the pagination bound it owns", () => {
    assert.equal(notificationsQuerySchema.parse({}).limit, 20);
  });

  it("honours searchable=false on the resource list", () => {
    const parsed = resourceQuerySchema.parse({ searchable: "false" });
    assert.equal(parsed.searchable, false);
  });

  it("rejects a nonsense boolean rather than inverting it", () => {
    assert.equal(taskQuerySchema.safeParse({ overdue: "maybe" }).success, false);
    assert.equal(groupSearchSchema.safeParse({ hasSpace: "kinda" }).success, false);
  });
});

describe("partial update schemas", () => {
  it("does not invent defaults for a session patch", () => {
    // A PATCH that fills in `status` and `mode` would let a client silently
    // overwrite the stored values it never mentioned.
    const parsed = updateSessionSchema.parse({ title: "Renamed" });

    assert.deepEqual(Object.keys(parsed), ["title"]);
    assert.equal(parsed.status, undefined);
    assert.equal(parsed.mode, undefined);
    assert.equal(parsed.startsAt, undefined);
  });

  it("still validates the fields that are present", () => {
    assert.equal(updateSessionSchema.safeParse({ startsAt: "not-a-date" }).success, false);
    assert.equal(updateSessionSchema.safeParse({ status: "NOT_A_STATUS" }).success, false);
    assert.equal(updateSessionSchema.safeParse({ startsAt: "2026-01-01T10:00:00Z" }).success, true);
  });

  it("still requires the fields a create actually owns", () => {
    // A group needs a name and a course; the title is derived.
    assert.equal(createGroupSchema.safeParse({}).success, false);
    assert.equal(createGroupSchema.safeParse({ name: "x" }).success, false);
    assert.equal(createGroupSchema.safeParse({ name: "Database Systems prep", courseId: "x" }).success, false);
  });
});

describe("student registration", () => {
  const requiredSignupFields = {
    firstName: "Taylor",
    lastName: "Student",
    email: "taylor@example.com",
    password: "StudyTogether2026",
    acceptTerms: true,
  };

  it("allows creating an account without academic details", () => {
    const parsed = registerSchema.parse(requiredSignupFields);

    assert.equal(parsed.universityId, undefined);
    assert.equal(parsed.programId, undefined);
    assert.equal(parsed.yearOfStudy, 1);
  });

  it("requires a university when a programme is provided", () => {
    assert.equal(
      registerSchema.safeParse({
        ...requiredSignupFields,
        programId: "6a457d9f-30e2-4c82-921e-1754ea5e7815",
      }).success,
      false,
    );
  });
});

describe("recommendation request", () => {
  it("applies only defaults a request is entitled to", () => {
    // Empty input is rejected by the service with INSUFFICIENT_REQUIREMENTS rather
    // than here, because the service can fall back to the student's own enrolments.
    // What matters is that parsing fills in the fields the service reads.
    const parsed = recommendationRequestSchema.parse({});

    assert.equal(parsed.kind, "GROUP");
    assert.deepEqual(parsed.topicIds, []);
    assert.deepEqual(parsed.availability, []);
    assert.equal(parsed.limit, 20);
    assert.equal(parsed.source, "FORM");
  });

  it("rejects an unknown match kind", () => {
    assert.equal(recommendationRequestSchema.safeParse({ kind: "ALGORITHM" }).success, false);
  });
});