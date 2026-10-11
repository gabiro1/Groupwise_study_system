import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cookieOptions } from "../src/lib/tokens.js";

describe("authentication cookie options", () => {
  it("keeps maxAge in milliseconds for Express", () => {
    assert.equal(cookieOptions({ maxAgeMs: 15 * 60 * 1000 }).maxAge, 15 * 60 * 1000);
    assert.equal(cookieOptions({ maxAgeMs: 30 * 24 * 60 * 60 * 1000 }).maxAge, 30 * 24 * 60 * 60 * 1000);
  });

  it("retains secure session cookie defaults", () => {
    const options = cookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.path, "/");
    assert.equal(options.sameSite, "lax");
  });
});
