import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/phase3/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.PHASE3_BASE_URL || "http://127.0.0.1:3000",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
});
