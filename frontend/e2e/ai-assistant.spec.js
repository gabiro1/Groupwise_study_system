import { test, expect } from "@playwright/test";

const email = process.env.PHASE3_STUDENT_EMAIL;
const password = process.env.PHASE3_STUDENT_PASSWORD;

test.describe("hybrid AI assistant", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!email || !password, "Set PHASE3_STUDENT_EMAIL and PHASE3_STUDENT_PASSWORD for AI browser coverage.");

    await page.route("**/api/ai/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            ai: { configured: true },
            capabilities: { webResearch: true },
            webSearch: { enabled: true, configured: true },
          },
        }),
      });
    });

    await page.route("**/api/ai/chat", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            available: true,
            answer: "Local evidence supports the concept, while the public source provides a current comparison. [LOCAL:1] [WEB:1]",
            sourceMode: "BOTH",
            grounded: true,
            sources: [
              { id: "LOCAL:1", sourceType: "LOCAL", title: "Shared biology note", kind: "NOTE", excerpt: "A local excerpt." },
              { id: "WEB:1", sourceType: "WEB", title: "Public academic source", domain: "example.edu", url: "https://example.edu/source", snippet: "A public excerpt.", publishedAt: "2026-01-02T00:00:00.000Z" },
            ],
            searches: [{ provider: "brave", sourceCount: 1, latencyMs: 120 }],
            limitations: [],
          },
        }),
      });
    });

    await page.goto("/login");
    await page.locator("input[name=email]").fill(email);
    await page.locator("input[name=password]").fill(password);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  });

  test("switches source mode and renders labelled citations", async ({ page }) => {
    await page.getByRole("button", { name: "Ask the study assistant" }).click();
    const selector = page.locator("#floating-assistant-source-mode");
    await expect(selector).toBeVisible();
    await selector.selectOption("BOTH");
    await expect(page.getByText("Both", { exact: true })).toBeVisible();

    await page.locator("#floating-assistant-input").fill("Compare this topic with current research");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Internet research performed")).toBeVisible();
    await expect(page.getByText("From your study material")).toBeVisible();
    await expect(page.getByText("Public web sources")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open source/ })).toHaveAttribute("rel", "noreferrer noopener");
    await expect(page.getByRole("button", { name: "Helpful" })).toBeVisible();
  });
});
