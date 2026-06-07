import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { endSessionForReader } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stop scanning: end the scan-session(s) so the reader(s) go cold. Used by a
 * page's "Stop scan" and by Hardware Config Live Scan's Stop / Stop All.
 *
 * Because non-POS readers are cold-by-default (paused) and only woken by a
 * scan-session, ending the session IS the override — there is nothing else
 * keeping a non-.34 reader on. The POS reader (.34) is schedule-driven, never
 * carries a scan-session, and is excluded from the all/IP lookups here, so it
 * is unaffected.
 *
 * Body: { readerIds?, networkAddresses?, all?, locationId? }
 *   - all=true → stop every non-POS reader at the location.
 *   - networkAddresses → stop specific readers by current IP.
 *   - readerIds → stop specific readers by id.
 */
const bodySchema = z.object({
  readerIds: z.array(z.string().uuid()).max(64).optional(),
  networkAddresses: z.array(z.string()).max(64).optional(),
  all: z.boolean().optional(),
  locationId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const readerIds = new Set<string>(parsed.data.readerIds ?? []);

  // Resolve "all" / IP-based targets to reader ids (POS excluded).
  if (parsed.data.all || (parsed.data.networkAddresses?.length ?? 0) > 0) {
    const locationId = parsed.data.locationId ?? session.lid ?? null;
    if (!locationId) {
      return NextResponse.json({ error: "No location" }, { status: 400 });
    }
    const params: unknown[] = [session.tid, locationId];
    let sql = `SELECT id::text
                 FROM devices
                WHERE tenant_id = $1::uuid
                  AND location_id = $2::uuid
                  AND device_type IN ('fixed_reader','transaction_reader','door_reader')
                  AND COALESCE(is_pos_dedicated, false) = false`;
    if (!parsed.data.all && parsed.data.networkAddresses?.length) {
      params.push(parsed.data.networkAddresses);
      sql += ` AND network_address = ANY($3::text[])`;
    }
    const r = await pool.query<{ id: string }>(sql, params);
    for (const row of r.rows) readerIds.add(row.id);
  }

  let stopped = 0;
  for (const rid of readerIds) {
    if (endSessionForReader(rid)) stopped += 1;
  }
  return NextResponse.json({ ok: true, stopped });
}
