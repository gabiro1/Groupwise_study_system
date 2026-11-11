import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aiProviderCreateSchema } from "../src/lib/schemas.js";
import { maskCredential } from "../src/services/aiCredential.service.js";
import { callProvider, isRetryableProviderError, resetCircuit } from "../src/modules/ai/orchestration.js";

describe("AI provider management validation", () => {
  it("requires a credential and model when adding a provider", () => {
    const result = aiProviderCreateSchema.safeParse({
      displayName: "Primary",
      providerType: "OPENAI",
      apiCredential: "secret",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
    });
    assert.equal(result.success, true);
  });

  it("rejects unsupported provider types", () => {
    const result = aiProviderCreateSchema.safeParse({
      displayName: "Unknown",
      providerType: "UNKNOWN",
      apiCredential: "secret",
      baseUrl: "https://example.com/v1",
      modelId: "model",
    });
    assert.equal(result.success, false);
  });
});

describe("AI credential and failover safety", () => {
  it("masks credentials without returning the complete value", () => {
    const masked = maskCredential("sk-live-123456");
    assert.equal(masked, "••••••••3456");
    assert.equal(masked.includes("sk-live"), false);
  });

  it("retries only transient provider failures", () => {
    assert.equal(isRetryableProviderError({ status: 429 }), true);
    assert.equal(isRetryableProviderError({ status: 503 }), true);
    assert.equal(isRetryableProviderError({ status: 401 }), false);
    assert.equal(isRetryableProviderError({ status: 400 }), false);
    assert.equal(isRetryableProviderError({ status: 400, contentSafetyRejection: true }), false);
  });

  it("fails over a transient provider error and stops on authentication failure", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
      };
      const result = await callProvider([{ role: "user", content: "ping" }], {
        targets: [
          { id: "test-primary", provider: "openai", adapter: "openai", apiKey: "a", baseUrl: "https://primary.test/v1", chatModel: "primary", timeoutMs: 1000 },
          { id: "test-fallback", provider: "openai", adapter: "openai", apiKey: "b", baseUrl: "https://fallback.test/v1", chatModel: "fallback", timeoutMs: 1000 },
        ],
        jsonMode: false,
        maxFailoverAttempts: 2,
      });
      assert.equal(result.model, "fallback");
      assert.equal(result.failoverCount, 1);
      assert.equal(calls, 2);

      globalThis.fetch = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      await assert.rejects(
        callProvider([{ role: "user", content: "ping" }], {
          targets: [
            { id: "auth-primary", provider: "openai", adapter: "openai", apiKey: "a", baseUrl: "https://primary.test/v1", chatModel: "primary", timeoutMs: 1000 },
            { id: "auth-fallback", provider: "openai", adapter: "openai", apiKey: "b", baseUrl: "https://fallback.test/v1", chatModel: "fallback", timeoutMs: 1000 },
          ],
          jsonMode: false,
          maxFailoverAttempts: 2,
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      resetCircuit();
    }
  });

  it("opens a circuit after the configured number of transient failures", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      };
      const target = { id: "circuit-test", provider: "openai", adapter: "openai", apiKey: "a", baseUrl: "https://primary.test/v1", chatModel: "primary", timeoutMs: 1000 };
      resetCircuit(target.id);
      for (let index = 0; index < 3; index += 1) {
        await assert.rejects(callProvider([{ role: "user", content: "ping" }], { targets: [target], jsonMode: false, maxFailoverAttempts: 1, failureThreshold: 3 }));
      }
      await assert.rejects(callProvider([{ role: "user", content: "ping" }], { targets: [target], jsonMode: false, maxFailoverAttempts: 1, failureThreshold: 3 }));
      assert.equal(calls, 3, "the open circuit should prevent a fourth upstream request");
    } finally {
      globalThis.fetch = originalFetch;
      resetCircuit();
    }
  });
});
