import { withActivity } from "@/lib/server/activity-log";
/**
 * PATCH /api/shopify/welcome-popup/settings — turn the email popup on/off or
 * change the offer (percent, days valid, delay, welcome email). Admin only.
 * Saved in the WMS, then copied to the shop metafield the theme reads, so the
 * store changes within a minute — no theme deploy.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { getWelcomeSettings, syncWelcomeMetafield } from "@/lib/server/welcome/config";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    enabled: z.boolean(),
    percentOff: z.number().int().min(1).max(50),
    validDays: z.number().int().min(1).max(365),
    delaySeconds: z.number().int().min(0).max(120),
    sendEmail: z.boolean(),
  })
  .partial()
  .strict();

const COLUMNS: Record<string, string> = {
  enabled: "enabled",
  percentOff: "percent_off",
  validDays: "valid_days",
  delaySeconds: "delay_seconds",
  sendEmail: "send_email",
};

async function PATCH_handler(req: Request) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!entries.length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  const before = await getWelcomeSettings(g.pool);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of entries) {
    vals.push(v);
    sets.push(`${COLUMNS[k]} = $${vals.length}`);
  }
  vals.push(g.session.email ?? null);
  await g.pool.query(
    `UPDATE welcome_settings SET ${sets.join(", ")}, updated_at = now(), updated_by_email = $${vals.length} WHERE id = 1`,
    vals,
  );
  const after = await getWelcomeSettings(g.pool);
  try {
    await syncWelcomeMetafield(after);
  } catch (e) {
    // The store would disagree with the WMS — put the old values back and say so.
    const restore = Object.keys(COLUMNS).map((k, i) => `${COLUMNS[k]} = $${i + 1}`);
    await g.pool.query(`UPDATE welcome_settings SET ${restore.join(", ")} WHERE id = 1`, [
      before.enabled,
      before.percentOff,
      before.validDays,
      before.delaySeconds,
      before.sendEmail,
    ]);
    return NextResponse.json(
      { error: `Not saved — the store could not be updated: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, settings: after });
}

export const PATCH = withActivity("shopify/welcome-popup/settings", PATCH_handler);
