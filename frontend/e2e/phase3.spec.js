import { test, expect } from "@playwright/test";

const accounts = {
  student: {
    email: process.env.PHASE3_STUDENT_EMAIL,
    password: process.env.PHASE3_STUDENT_PASSWORD,
  },
  groupStudent: {
    email: process.env.PHASE3_GROUP_STUDENT_EMAIL,
    password: process.env.PHASE3_GROUP_STUDENT_PASSWORD,
  },
  leader: {
    email: process.env.PHASE3_LEADER_EMAIL,
    password: process.env.PHASE3_LEADER_PASSWORD,
  },
  admin: {
    email: process.env.PHASE3_ADMIN_EMAIL,
    password: process.env.PHASE3_ADMIN_PASSWORD,
  },
};

function requireAccount(role) {
  const account = accounts[role];
  if (!account?.email || !account?.password) {
    throw new Error(`Set PHASE3_${role.toUpperCase()}_EMAIL and PHASE3_${role.toUpperCase()}_PASSWORD before running browser tests.`);
  }
  return account;
}

async function login(page, role) {
  const account = requireAccount(role);
  await page.goto("/login");
  await page.locator("input[name=email]").fill(account.email);
  await page.locator("input[name=password]").fill(account.password);
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.waitForURL(/\/dashboard|\/admin/, { timeout: 60_000 });
}

async function saveStudentMatchingProfile(page) {
  await page.goto("/dashboard/profile");
  await page.getByRole("button", { name: "Courses & goals" }).click();

  const coursesForm = page.locator("form").filter({ hasText: "Choose the courses" });
  const aiCourse = coursesForm.locator("label").filter({ hasText: "Artificial Intelligence" }).locator("input");
  await expect(aiCourse).toBeVisible();
  if (!(await aiCourse.isChecked())) await aiCourse.check();
  await coursesForm.getByRole("button", { name: "Save courses" }).click();

  const goalsForm = page.locator("form").filter({ hasText: "Choose one or more goals" });
  const goalLabels = ["Exam preparation", "Assignment", "Improve understanding", "Practice problems", "Peer teaching", "General revision", "Research project"];
  for (const label of goalLabels) {
    const checkbox = goalsForm.locator("label").filter({ hasText: label }).locator("input");
    if (!(await checkbox.count())) continue;
    const shouldBeChecked = label === "Exam preparation";
    if ((await checkbox.isChecked()) !== shouldBeChecked) {
      if (shouldBeChecked) await checkbox.check();
      else await checkbox.uncheck();
    }
  }
  await goalsForm.getByRole("button", { name: "Save learning goals" }).click();
  await expect(page.getByText("Learning goals saved.")).toBeVisible({ timeout: 30_000 });
}

test.describe("Phase 3 browser validation", () => {
  test("registration validation, login, logout, and protected-page redirect", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Create your study space." })).toBeVisible();

    await page.locator("input[name=firstName]").fill("Phase");
    await page.locator("input[name=lastName]").fill("Three");
    await page.locator("input[name=email]").fill(requireAccount("student").email);
    await page.locator("input[name=password]").fill("ValidPassword1");
    await page.locator("input[name=confirmPassword]").fill("DifferentPassword1");
    await page.getByRole("checkbox", { name: /I agree/ }).check();
    await page.getByRole("button", { name: /Create student account/ }).click();
    await expect(page.locator(".auth-alert")).toContainText("Passwords do not match.");

    await page.goto("/login");
    await page.locator("input[name=email]").fill(requireAccount("student").email);
    await page.locator("input[name=password]").fill("definitely-wrong-password");
    await page.getByRole("button", { name: /Sign in/ }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    await login(page, "student");
    await expect(page.getByText("YOUR SPACE")).toBeVisible();
    await page.screenshot({ path: "artifacts/phase3/student-dashboard.png", fullPage: true });

    await page.getByRole("button", { name: "Open profile menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/$/);
    await page.goto("/dashboard/profile");
    await page.waitForURL(/\/login/);
  });

  test("student profile, group recommendations, and backend explanation agreement", async ({ page }) => {
    await login(page, "student");
    await saveStudentMatchingProfile(page);

    const groupResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes("/api/recommendations") || response.request().method() !== "POST") return false;
      try { return JSON.parse(response.request().postData() || "{}").kind === "GROUP"; } catch { return false; }
    });
    await page.goto("/dashboard/recommendations");
    await expect(page.getByRole("heading", { name: "Recommended for you" })).toBeVisible();
    const groupPayload = await (await groupResponsePromise).json();
    const group = groupPayload.data.results[0];
    expect(group).toBeTruthy();
    expect(group.score).toBeGreaterThanOrEqual(40);
    expect(group.explanation.length).toBeGreaterThan(0);

    const card = page.locator(".recommendation-card").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".match-score strong")).toHaveText(`${Math.round(group.score)}%`);
    await expect(card).toContainText("Why this group?");
    await expect(card).toContainText(group.reasons[0].detail);
    await expect(card.getByRole("button", { name: "Join group" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Study partners" })).toHaveCount(0);
    await page.screenshot({ path: "artifacts/phase3/group-recommendation.png", fullPage: true });

    const removedRoute = await page.goto("/dashboard/partners");
    expect(removedRoute?.status()).toBe(404);
  });

  test("group recommendations, eligibility messaging, group discovery, sessions, and notifications", async ({ page }) => {
    await login(page, "groupStudent");
    await saveStudentMatchingProfile(page);

    const groupResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes("/api/recommendations") || response.request().method() !== "POST") return false;
      try { return JSON.parse(response.request().postData() || "{}").kind === "GROUP"; } catch { return false; }
    });
    await page.goto("/dashboard/recommendations");
    const groupResponse = await groupResponsePromise;
    const groupPayload = await groupResponse.json();
    const group = groupPayload.data.results[0];
    expect(group).toBeTruthy();
     expect(group.groupId).toBeTruthy();
    expect(group.score).toBeGreaterThanOrEqual(40);

    const card = page.locator(".recommendation-card").first();
    await expect(card).toContainText("Why this group?");
    await expect(card.locator(".match-score strong")).toHaveText(`${Math.round(group.score)}%`);
    await expect(card).toContainText(group.reasons[0].detail);
    await expect(card.getByRole("button", { name: "Join group" })).toBeVisible();
    await page.screenshot({ path: "artifacts/phase3/group-recommendation.png", fullPage: true });

    await page.goto("/dashboard/discover");
    await expect(page.getByRole("heading", { name: "Find your study group" })).toBeVisible();
    await expect(page.getByText(group.name)).toBeVisible();

    await page.goto("/dashboard/sessions");
    await expect(page.getByRole("heading", { name: "Your upcoming sessions" })).toBeVisible();

    await page.goto("/dashboard/notifications");
    await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
  });

  test("student cannot use administrator routes", async ({ page }) => {
    await login(page, "student");
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
    await expect(page.getByText("Admin dashboard")).not.toBeVisible();
  });

  test("administrator login, user management, matching, and catalogue pages", async ({ page }) => {
    await login(page, "admin");
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: /Users/ })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search users" })).toBeVisible();

    await page.goto("/admin/matching");
    await expect(page.getByText("Requests", { exact: true })).toBeVisible();
    await expect(page.getByText("Generated", { exact: true })).toBeVisible();

    await page.goto("/admin/academic");
    await expect(page.getByRole("heading", { name: "Course register" })).toBeVisible();
    await page.screenshot({ path: "artifacts/phase3/admin-academic.png", fullPage: true });
  });
});
