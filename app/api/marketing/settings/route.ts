import { withActivity } from "@/lib/server/activity-log";
/**
 * PATCH /api/marketing/settings — turn publishing on or off for the whole
 * tenant. While it is off, approved posts wait and nothing is sent anywhere.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getMarketingSettings } from "@/lib/server/marketing/store";

export const dynamic = "force-dynamic";

const schema = z.object({ publishEnabled: z.boolean() }).strict();

async function PATCH_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  await g.pool.query(
    `INSERT INTO marketing_settings (tenant_id, publish_enabled, updated_at, updated_by) VALUES ($1::uuid, $2, now(), $3)
     ON CONFLICT (tenant_id) DO UPDATE SET publish_enabled = EXCLUDED.publish_enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [g.session.tid, parsed.data.publishEnabled, g.session.email ?? null],
  );
  return NextResponse.json({ settings: await getMarketingSettings(g.pool, g.session.tid) });
}

export const PATCH = withActivity("marketing/settings", PATCH_handler);
