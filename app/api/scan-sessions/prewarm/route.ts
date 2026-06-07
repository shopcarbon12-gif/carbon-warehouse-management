import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { createSession, type ScanSessionKind } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pre-warm: ENTERING a scanning page wakes the readers it might use, so they
 * are already warm by the time the operator picks readers and clicks Start.
 * The trigger to power readers is page-entry, NOT "Start scan" — Start only
 * begins COUNTING (each page gates its own capture on the Start click).
 *
 * Idempotent: call repeatedly (every ~15s) as a combined warm-up + heartbeat.
 * Readers already woken by another session are skipped (already warm). The
 * POS-dedicated reader is NEVER pre-warmed — it is schedule-driven and exempt.
 *
 * Body: { kind, locationId?, readerIds? }
 *   - kind        : which page is warming (telemetry + the 10-min-idle exemption;
 *                   "cycle-count" sessions are exempt from the idle auto-stop)
 *   - locationId? : defaults to the caller's session location
 *   - readerIds?  : narrow to a specific set; default = all non-POS readers at
 *                   the location
 *
 * Response: { ok: true, sessions: [{ readerId, sessionId }] }
 *   The page heart-beats these sessionIds via /api/scan-sessions/touch.
 */
const bodySchema = z.object({
  kind: z.enum([
    "transfer-out",
    "cycle-count",
    "print-commission",
    "encode-items",
    "bulk-import",
    "bulk-status",
    "bulk-geiger",
    "scan-epc",
  ]),
  locationId: z.string().uuid().optional(),
  // Narrow to specific readers, by id and/or by current IP (network_address).
  // Omit BOTH → all non-POS readers at the location.
  readerIds: z.array(z.string().uuid()).max(64).optional(),
  networkAddresses: z.array(z.string()).max(64).optional(),
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const locationId = parsed.data.locationId ?? session.lid ?? null;
  if (!locationId) {
    return NextResponse.json({ error: "No location" }, { status: 400 });
  }

  // Candidate readers: fixed readers at this location, tenant-scoped, NOT
  // POS-dedicated. Optionally narrowed to a specific id/IP set.
  const params: unknown[] = [session.tid, locationId];
  let sql = `SELECT id::text
               FROM devices
              WHERE tenant_id = $1::uuid
                AND location_id = $2::uuid
                AND device_type IN ('fixed_reader','transaction_reader','door_reader')
                AND COALESCE(is_pos_dedicated, false) = false`;
  const ids = parsed.data.readerIds ?? [];
  const ips = parsed.data.networkAddresses ?? [];
  if (ids.length > 0 || ips.length > 0) {
    const ors: string[] = [];
    if (ids.length > 0) {
      params.push(ids);
      ors.push(`id = ANY($${params.length}::uuid[])`);
    }
    if (ips.length > 0) {
      params.push(ips);
      ors.push(`network_address = ANY($${params.length}::text[])`);
    }
    sql += ` AND (${ors.join(" OR ")})`;
  }
  const r = await pool.query<{ id: string }>(sql, params);

  const sessions: Array<{ readerId: string; sessionId: string }> = [];
  for (const row of r.rows) {
    const res = createSession({
      tenantId: session.tid,
      locationId,
      readerId: row.id,
      kind: parsed.data.kind as ScanSessionKind,
      context: { prewarm: true },
      startedBy: session.sub ?? null,
    });
    // res.ok=false means the reader is busy under another session — it's
    // already warm, so we simply don't track it for this page.
    if (res.ok) {
      sessions.push({ readerId: res.session.readerId, sessionId: res.session.id });
    }
  }

  return NextResponse.json({ ok: true, sessions });
}
