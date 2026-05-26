import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { touchSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Per-tenant in-memory result cache. The DISTINCT ON (epc_hex) over a
 * tenant's session-window of cdm_reads is the most expensive query in
 * the live-scan path — at warehouse scale (~1M reads in 30 min) each
 * call takes 2-7 s and saturates the DB pool when multiple dashboards
 * are open. The dashboard polls this route every ~2 s, so caching for
 * 3 s collapses N concurrent dashboards into a single DB query.
 * Live evidence 2026-05-09 20:29 ET: 11 concurrent active sessions all
 * running this same query, /api/cdm-agents/* timing out with HTTP 500
 * because the pool was full. */
const CACHE_TTL_MS = 3000;
type CachedAntennas = {
  expiresAtMs: number;
  payload: ReturnType<typeof buildPayload>;
};
const cacheByTenant = new Map<string, CachedAntennas>();
type AntennaRow = {
  reader_id: string;
  reader_name: string;
  antenna_id: string;
  antenna_name: string;
  antenna_number: number;
  network_address: string | null;
  unique_epcs: number;
  total_reads: number;
};
function buildPayload(rows: AntennaRow[], startedAtMs: number) {
  return {
    ok: true as const,
    active: true as const,
    started_at: new Date(startedAtMs).toISOString(),
    antennas: rows,
  };
}

/**
 * Per-antenna breakdown of unique EPCs read in the current live-scan session.
 * Mirrors the aggregate counter in /state, but split by antenna so the
 * operator can see which antenna is contributing what. Counts unique EPCs
 * (not raw read rows) and only counts items currently `in-stock` so the
 * sum aligns with the headline live-scan number.
 *
 * Response shape:
 *   { ok, active, started_at, antennas: [
 *       { reader_name, antenna_name, antenna_number, network_address, unique_epcs }
 *     ] }
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const s = touchSession(session.tid);
  if (!s) {
    return NextResponse.json({ ok: true, active: false, started_at: null, antennas: [] });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const cached = cacheByTenant.get(session.tid);
  if (cached && cached.expiresAtMs > Date.now()) {
    return NextResponse.json(cached.payload);
  }

  /* For every Carbon-owned antenna on this tenant, count BOTH:
   *  - unique_epcs: distinct EPCs ATTRIBUTED to this antenna. Each EPC is
   *    attributed to the FIRST antenna that decoded it in this session, so
   *    summing unique_epcs across antennas equals the headline live-scan
   *    unique. Without first-antenna attribution, multi-antenna readers
   *    (e.g. Transfer Bin with the supervisor mux) would have each antenna
   *    showing nearly the full session count once tags are seen by both —
   *    operator wants to see which antenna picked which tag, not "both
   *    saw the same tag".
   *  - total_reads: raw read count from this antenna in the session window
   *    (regardless of formula). Useful for "is this antenna alive?"
   *    diagnosis — if total_reads is climbing but unique_epcs is 0,
   *    the antenna is hearing noise that doesn't decode OR its tags were
   *    already attributed to another antenna.
   *
   * Excluded by design: antenna-test sessions and settings flows want
   * per-antenna RAW counts (they ARE the diagnostic). They use a separate
   * code path; this attribution rule applies only to live-scan dashboards
   * and workflow scan-sessions where the operator cares about coverage.
   */
  const r = await pool.query<{
    reader_id: string;
    reader_name: string;
    antenna_id: string;
    antenna_name: string;
    antenna_number: number;
    network_address: string | null;
    unique_epcs: string;
    total_reads: string;
  }>(
    // 2026-05-26: dropped `is_pos_dedicated = FALSE` filters in all
    // three places (first_attribution CTE, read_totals CTE, final
    // SELECT). Operator wants POS-dedicated readers (e.g. .34) to
    // appear in hardware_config's Live Scan alongside the wired
    // readers. The widget surfaces a per-reader toggle so the
    // operator can hide a row's contribution from the headline
    // without round-tripping through the SQL.
    `WITH first_attribution AS (
       SELECT DISTINCT ON (cr.epc_hex)
         cr.epc_hex,
         cr.antenna_id
       FROM cdm_reads cr
       WHERE cr.tenant_id = $1::uuid
         AND cr.read_at   >= $2::timestamptz
         AND cr.passes_formula
       ORDER BY cr.epc_hex, cr.read_at ASC
     ),
     attribution_counts AS (
       SELECT antenna_id, COUNT(*)::int AS uniq
       FROM first_attribution
       GROUP BY antenna_id
     ),
     read_totals AS (
       SELECT cr.antenna_id, COUNT(*)::int AS total
       FROM cdm_reads cr
       WHERE cr.tenant_id = $1::uuid
         AND cr.read_at >= $2::timestamptz
       GROUP BY cr.antenna_id
     )
     SELECT
       parent.id::text                 AS reader_id,
       parent.name                     AS reader_name,
       a.id::text                      AS antenna_id,
       a.name                          AS antenna_name,
       (a.config->>'antenna_number')::int AS antenna_number,
       parent.network_address          AS network_address,
       COALESCE(ac.uniq, 0)::text      AS unique_epcs,
       COALESCE(rt.total, 0)::text     AS total_reads
     FROM devices a
     INNER JOIN devices parent ON parent.id = a.parent_device_id
     INNER JOIN locations l    ON l.id = parent.location_id AND l.tenant_id = $1::uuid
     LEFT JOIN attribution_counts ac ON ac.antenna_id = a.id
     LEFT JOIN read_totals       rt ON rt.antenna_id = a.id
     WHERE a.device_type = 'antenna'
     ORDER BY parent.name ASC, antenna_number ASC`,
    [session.tid, new Date(s.startedAt).toISOString()],
  );

  const antennas: AntennaRow[] = r.rows.map((row) => ({
    reader_id: row.reader_id,
    reader_name: row.reader_name,
    antenna_id: row.antenna_id,
    antenna_name: row.antenna_name,
    antenna_number: row.antenna_number,
    network_address: row.network_address,
    unique_epcs: Number(row.unique_epcs),
    total_reads: Number(row.total_reads),
  }));
  const payload = buildPayload(antennas, s.startedAt);
  cacheByTenant.set(session.tid, {
    expiresAtMs: Date.now() + CACHE_TTL_MS,
    payload,
  });
  return NextResponse.json(payload);
}
