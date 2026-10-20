import { withActivity } from "@/lib/server/activity-log";
/**
 * PATCH /api/shopify/carbon-shield/settings — change Carbon Shield's mode
 * (off / monitor / enforce) or its checks. Admin only; applies to the next
 * storefront check (the config cache is dropped).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { shieldAdminGuard } from "@/lib/server/shield/guard";
import { invalidateShieldConfig } from "@/lib/server/shield/check";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    mode: z.enum(["off", "monitor", "enforce"]),
    allowedCountries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).max(60),
    blockCountries: z.boolean(),
    blockDatacenter: z.boolean(),
    blockAutomation: z.boolean(),
    blockFast: z.boolean(),
    maxPagesPerMinute: z.number().int().min(5).max(1000),
    silencePixels: z.boolean(),
  })
  .partial()
  .strict();

const COLUMNS: Record<string, string> = {
  mode: "mode",
  allowedCountries: "allowed_countries",
  blockCountries: "block_countries",
  blockDatacenter: "block_datacenter",
  blockAutomation: "block_automation",
  blockFast: "block_fast",
  maxPagesPerMinute: "max_pages_per_minute",
  silencePixels: "silence_pixels",
};

async function PATCH_handler(req: Request) {
  const g = await shieldAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!entries.length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of entries) {
    vals.push(k === "allowedCountries" ? (v as string[]).map((c) => c.toUpperCase()) : v);
    sets.push(`${COLUMNS[k]} = $${vals.length}`);
  }
  vals.push(g.session.email ?? null);
  await g.pool.query(
    `UPDATE shield_settings SET ${sets.join(", ")}, updated_at = now(), updated_by_email = $${vals.length} WHERE id = 1`,
    vals,
  );
  invalidateShieldConfig();
  return NextResponse.json({ ok: true });
}

export const PATCH = withActivity("shopify/carbon-shield/settings", PATCH_handler);
