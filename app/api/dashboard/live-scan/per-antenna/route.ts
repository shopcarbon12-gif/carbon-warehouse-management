import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { touchSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  /* For every Carbon-owned antenna on this tenant, count the distinct EPCs that
   * (a) have been read on this antenna since the session started, AND
   * (b) are currently 'in-stock' in items. The (b) filter keeps the sum
   *     consistent with the aggregate counter in /state. */
  const r = await pool.query<{
    reader_id: string;
    reader_name: string;
    antenna_id: string;
    antenna_name: string;
    antenna_number: number;
    network_address: string | null;
    unique_epcs: string;
  }>(
    `SELECT
       parent.id::text                 AS reader_id,
       parent.name                     AS reader_name,
       a.id::text                      AS antenna_id,
       a.name                          AS antenna_name,
       (a.config->>'antenna_number')::int AS antenna_number,
       parent.network_address          AS network_address,
       COALESCE(read_counts.n, 0)::text AS unique_epcs
     FROM devices a
     INNER JOIN devices parent ON parent.id = a.parent_device_id
     INNER JOIN locations l    ON l.id = parent.location_id AND l.tenant_id = $1::uuid
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT cr.epc_hex) AS n
         FROM cdm_reads cr
         INNER JOIN items i ON i.epc = cr.epc_hex
         WHERE cr.tenant_id = $1::uuid
           AND cr.antenna_id = a.id
           AND cr.read_at    >= $2::timestamptz
           AND i.status      = 'in-stock'
     ) read_counts ON TRUE
     WHERE a.device_type = 'antenna'
     ORDER BY parent.name ASC, antenna_number ASC`,
    [session.tid, new Date(s.startedAt).toISOString()],
  );

  return NextResponse.json({
    ok: true,
    active: true,
    started_at: new Date(s.startedAt).toISOString(),
    antennas: r.rows.map((row) => ({
      reader_id: row.reader_id,
      reader_name: row.reader_name,
      antenna_id: row.antenna_id,
      antenna_name: row.antenna_name,
      antenna_number: row.antenna_number,
      network_address: row.network_address,
      unique_epcs: Number(row.unique_epcs),
    })),
  });
}
