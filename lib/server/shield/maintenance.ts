/**
 * Carbon Shield housekeeping, run by the worker (scripts/worker.ts):
 *  - daily totals for yesterday and today (Eastern) from the raw rows;
 *  - raw rows older than 7 days deleted, so the log can never fill the disk;
 *  - the IP data rebuilt once a day.
 */
import type { Pool } from "pg";
import { refreshIpDbIfStale } from "./ipdb";
import { pruneVisitors } from "@/lib/server/visitors/record";

export async function rollupShieldDaily(pool: Pool): Promise<void> {
  /* Whole days only (yesterday 00:00 ET onward), so a day is never
     overwritten by a partial count. */
  await pool.query(
    `WITH bounds AS (
       SELECT ((date_trunc('day', now() AT TIME ZONE 'America/New_York') - interval '1 day') AT TIME ZONE 'America/New_York') AS since
     )
     INSERT INTO shield_daily (day, would_verdict, reason, source, country, visits, visitors)
     SELECT (e.at AT TIME ZONE 'America/New_York')::date,
            e.would_verdict,
            coalesce(e.reasons[1], CASE WHEN e.good_bot IS NOT NULL THEN 'good_bot' ELSE 'none' END),
            coalesce(nullif(e.source, ''), 'direct'),
            coalesce(e.country, '??'),
            count(*)::int,
            count(DISTINCT e.visitor_id)::int
       FROM shield_events e, bounds
      WHERE e.at >= bounds.since
      GROUP BY 1, 2, 3, 4, 5
     ON CONFLICT (day, would_verdict, reason, source, country)
     DO UPDATE SET visits = EXCLUDED.visits, visitors = EXCLUDED.visitors`,
  );
}

export async function pruneShieldEvents(pool: Pool): Promise<number> {
  const r = await pool.query(`DELETE FROM shield_events WHERE at < now() - interval '7 days'`);
  return r.rowCount ?? 0;
}

let lastTick = 0;
const TICK_MS = 15 * 60_000;

/** Called on every worker loop; does real work at most every 15 minutes. */
export async function maybeRunShieldMaintenance(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastTick < TICK_MS) return;
  lastTick = now;
  try {
    await rollupShieldDaily(pool);
    const pruned = await pruneShieldEvents(pool);
    if (pruned) console.log(`[worker] shield: pruned ${pruned} raw rows older than 7 days`);
    const v = await pruneVisitors(pool);
    if (v.events || v.visitors) console.log(`[worker] visitors: pruned ${v.events} events, ${v.visitors} visitors older than 90 days`);
  } catch (e) {
    console.error("[worker] shield rollup/prune failed", e);
  }
  try {
    if (await refreshIpDbIfStale(pool)) console.log("[worker] shield: IP data refreshed");
  } catch (e) {
    console.error("[worker] shield IP data refresh failed", e);
  }
}
