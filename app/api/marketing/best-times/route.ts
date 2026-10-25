import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/marketing/best-times — audience activity by weekday and hour
 *      (America/New_York), per channel, plus the top suggested slots.
 * POST /api/marketing/best-times — refresh from Instagram (followers online).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { instagramOnlineFollowers } from "@/lib/server/marketing/meta";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const r = await g.pool.query<{ provider: string; weekday: number; hour: number; score: string; computed_at: Date }>(
    `SELECT provider, weekday, hour, score, computed_at FROM marketing_best_times WHERE tenant_id = $1::uuid ORDER BY provider, weekday, hour`,
    [g.session.tid],
  );
  const byProvider: Record<string, { grid: number[][]; computedAt: string; top: { weekday: number; hour: number; score: number }[] }> = {};
  for (const row of r.rows) {
    const p = (byProvider[row.provider] ??= { grid: Array.from({ length: 7 }, () => Array(24).fill(0)), computedAt: row.computed_at.toISOString(), top: [] });
    p.grid[row.weekday][row.hour] = Number(row.score);
  }
  for (const p of Object.values(byProvider)) {
    // Best hour per weekday, between 8 AM and 10 PM.
    p.top = p.grid.map((hours, weekday) => {
      let best = 8;
      for (let h = 8; h <= 22; h++) if (hours[h] > hours[best]) best = h;
      return { weekday, hour: best, score: hours[best] };
    });
  }
  return NextResponse.json({ providers: byProvider });
}

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const ig = await g.pool.query<{ account_id: string }>(
    `SELECT account_id FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'instagram' AND status = 'connected' LIMIT 1`,
    [g.session.tid],
  );
  if (!ig.rows[0]) return NextResponse.json({ error: "Connect Instagram first (Integrations → Social channels → Sync Meta accounts)" }, { status: 409 });
  let rows;
  try {
    rows = await instagramOnlineFollowers(ig.rows[0].account_id);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!rows.length) return NextResponse.json({ error: "Instagram returned no audience data yet" }, { status: 502 });
  const client = await g.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM marketing_best_times WHERE tenant_id = $1::uuid AND provider = 'instagram'`, [g.session.tid]);
    for (const x of rows)
      await client.query(
        `INSERT INTO marketing_best_times (tenant_id, provider, weekday, hour, score, computed_at) VALUES ($1::uuid, 'instagram', $2, $3, $4, now())`,
        [g.session.tid, x.weekday, x.hour, x.score],
      );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ points: rows.length });
}

export const POST = withActivity("marketing/best-times", POST_handler);
