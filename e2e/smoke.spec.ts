import { test, expect } from "@playwright/test";

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("health endpoint", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  const j = (await res.json()) as { ok: boolean };
  expect(j.ok).toBe(true);
});

test("protected API returns JSON 401 without session", async ({ request }) => {
  const res = await request.get("/api/dashboard/summary");
  expect(res.status()).toBe(401);
  const j = (await res.json()) as { error?: string };
  expect(j.error).toBeTruthy();
});
