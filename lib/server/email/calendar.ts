/**
 * CarbonWMS Email — the campaign calendar's reminders (owner's CARBON pack): 14 days before each
 * seasonal send, one phone/computer alert (Settings › Alerts, "Social & marketing") to swap in
 * photos and products. Once per send; checked with the order sync (every 5 minutes).
 */
import type { Pool } from "pg";
import { sendPush } from "@/lib/server/web-push";
import { upcoming } from "@/lib/email-editor/calendar";

export async function runCalendarReminders(pool: Pool, log: (m: string) => void = console.log): Promise<number> {
  const t = await pool.query<{ tenant_id: string }>(`SELECT tenant_id::text FROM email_settings LIMIT 1`);
  const tenant = t.rows[0]?.tenant_id;
  if (!tenant) return 0;
  let n = 0;
  for (const u of upcoming(new Date(), 14)) {
    const key = `cal:${u.template}:${u.sendOn}`;
    const ins = await pool.query(`INSERT INTO email_flow_state (tenant_id, key, value) VALUES ($1::uuid, $2, 'reminded') ON CONFLICT DO NOTHING`, [tenant, key]);
    if (!ins.rowCount) continue;
    const when = new Date(`${u.sendOn}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
    await sendPush(pool, {
      kind: "social",
      title: `Email: ${u.name} goes out ${u.daysLeft === 0 ? "today" : `in ${u.daysLeft} day${u.daysLeft === 1 ? "" : "s"}`}`,
      body: `Send ${when}. Open Email Marketing › Calendar to start it from the CARBON template and swap in your photos and products.`,
      url: "/marketing/email?tab=calendar",
      tag: key,
    }).catch((e) => log(`[email] calendar reminder: ${e instanceof Error ? e.message : String(e)}`));
    n++;
  }
  return n;
}
