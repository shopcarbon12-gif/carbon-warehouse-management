import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Dashboard's "Last count" pill (owner 2026-10-22: it should be the last
 * cycle count, minus what changed since, plus what was added). The newest
 * count that took effect at this location — a committed cycle count session or
 * a count pushed from Reports → Counts — reconciled against live stock now:
 *
 *   counted  tags in that count
 *   gone     counted tags that are not live here now (sold, moved, killed …)
 *   added    live tags here now that the count did not have (new tags, and
 *            anything the count missed)
 *   now      counted − gone + added = live stock at this location
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const r = await pool.query<{ at: string | null; counted: number; gone: number; added: number; now: number }>(
    `WITH c AS (
       -- Newest by when it took effect; shown with the day it was scanned
       -- (a pushed count's first file), not the day it was pushed.
       SELECT scanned_epcs, scanned_at AS at FROM (
         SELECT scanned_epcs, coalesce(completed_at, started_at) AS took_effect, started_at AS scanned_at
           FROM cycle_count_sessions
          WHERE tenant_id = $1::uuid AND location_id = $2::uuid AND status = 'committed'
         UNION ALL
         SELECT p.scanned_epcs, p.created_at,
                coalesce((SELECT min(r.uploaded_at) FROM inventory_reports r WHERE r.id = ANY(p.report_ids)), p.created_at)
           FROM count_pushes p
          WHERE p.tenant_id = $1::uuid AND p.location_id = $2::uuid AND p.scanned_epcs IS NOT NULL
       ) x ORDER BY took_effect DESC LIMIT 1
     ),
     s AS (SELECT DISTINCT upper(e) AS epc FROM c, jsonb_array_elements_text(c.scanned_epcs) AS e),
     live AS (SELECT DISTINCT upper(epc) AS epc FROM items WHERE location_id = $2::uuid AND status = 'in-stock')
     SELECT (SELECT at::text FROM c) AS at,
            (SELECT count(*) FROM s)::int AS counted,
            (SELECT count(*) FROM s WHERE NOT EXISTS (SELECT 1 FROM live WHERE live.epc = s.epc))::int AS gone,
            (SELECT count(*) FROM live WHERE NOT EXISTS (SELECT 1 FROM s WHERE s.epc = live.epc))::int AS added,
            (SELECT count(*) FROM live)::int AS now`,
    [session.tid, session.lid],
  );
  const row = r.rows[0];
  return NextResponse.json(
    { last_count: row?.at ? row : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
