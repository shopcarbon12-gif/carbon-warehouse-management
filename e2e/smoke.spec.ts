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

/**
 * Optional: set PLAYWRIGHT_PUBLIC_BASE_URL=https://wms.example.com to probe production
 * when local dev (3040) is broken or unavailable. Skipped by default in CI unless env is set.
 */
const publicBase = process.env.PLAYWRIGHT_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "";

test.describe("public origin probes", () => {
  test.skip(!publicBase, "PLAYWRIGHT_PUBLIC_BASE_URL unset");

  test("GET /api/health on public base", async ({ request }) => {
    const res = await request.get(`${publicBase}/api/health`);
    expect(res.ok()).toBeTruthy();
    const j = (await res.json()) as { ok?: boolean };
    expect(j.ok).toBe(true);
  });

  test("GET /api/dashboard/summary without auth on public base", async ({ request }) => {
    const res = await request.get(`${publicBase}/api/dashboard/summary`);
    expect(res.status()).toBe(401);
    const j = (await res.json()) as { error?: string };
    expect(j.error).toBeTruthy();
  });
});
