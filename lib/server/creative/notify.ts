/**
 * CarbonWMS Creative — desktop alerts (owner, 2026-11-15: "when the batch is ready, a notification on the
 * desktop plus a sound"). Uses the WMS browser alerts (Settings › Alerts): the computer's own notification
 * with its sound, and the chime on any open WMS page. Never throws — an alert must not fail a job.
 */
import type { Pool } from "pg";
import { sendPush } from "@/lib/server/web-push";

export async function notifyCreative(pool: Pool, tenantId: string, v: { title: string; body: string; url: string; tag: string }): Promise<void> {
  await sendPush(pool, { kind: "creative", title: v.title, body: v.body, url: v.url, tag: v.tag, sound: "studio" }, { tenantId }).catch(() => undefined);
}
