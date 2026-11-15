/**
 * CarbonWMS Creative — desktop alerts (owner, 2026-11-15: "when the batch is ready, a notification on the
 * desktop plus a sound"). Uses the WMS browser alerts (Settings › Alerts): the computer's own notification
 * with its sound, and the chime on any open WMS page. Only ADMINS get them — Creative is admin-only, so floor
 * staff never get alerts for a page they can't open (review 2026-11-15). Never throws.
 */
import type { Pool } from "pg";
import { sendPush } from "@/lib/server/web-push";

export async function notifyCreative(pool: Pool, tenantId: string, v: { title: string; body: string; url: string; tag: string }): Promise<void> {
  try {
    const admins = await pool.query<{ user_id: string }>(`SELECT user_id::text FROM memberships WHERE tenant_id = $1::uuid AND role = 'admin'`, [tenantId]);
    for (const a of admins.rows) await sendPush(pool, { kind: "creative", title: v.title, body: v.body, url: v.url, tag: v.tag, sound: "studio" }, { tenantId, userId: a.user_id });
  } catch {
    /* an alert must never fail a job */
  }
}
