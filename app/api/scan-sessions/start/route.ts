import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  createSession,
  type ScanSessionKind,
} from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wake a reader for a workflow. Called from Transfer Out / Cycle Counts /
 * Print-Commission "Start scan" buttons.
 *
 * Side effect: the agent's next active-sessions poll (250ms cadence) will
 * see this session and the supervisor will spawn a child for the reader,
 * overriding any persisted scan_paused_at. When the workflow commits
 * (POST /api/scan-sessions/end) or an admin pauses the reader from
 * Hardware Config, the reader returns to its default state. There is NO
 * idle timeout — sessions persist until explicitly ended (by design;
 * see lib/server/scan-sessions.ts).
 *
 * Body: { readerId, kind, context? }
 *  - kind: "transfer-out" | "cycle-count" | "print-commission"
 *  - context: free-form bag (slip number, count id, etc.) — telemetry only
 *
 * Response: { ok: true, sessionId }   on success
 *           { ok: false, reason: "reader_busy", existing: {...} }   if another workflow already woke this reader
 */

const bodySchema = z.object({
  readerId: z.string().uuid(),
  kind: z.enum(["transfer-out", "cycle-count", "print-commission"]),
  context: z.record(z.string(), z.unknown()).optional(),
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

  // Verify the reader belongs to the caller's tenant + location, and grab
  // its location_id for the session record.
  const r = await pool.query<{ id: string; location_id: string }>(
    `SELECT id::text, location_id::text
       FROM devices
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [parsed.data.readerId, session.tid],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  const reader = r.rows[0]!;
  if (session.lid && reader.location_id !== session.lid) {
    return NextResponse.json(
      { error: "Reader belongs to another location" },
      { status: 403 },
    );
  }

  const result = createSession({
    tenantId: session.tid,
    locationId: reader.location_id,
    readerId: reader.id,
    kind: parsed.data.kind as ScanSessionKind,
    context: parsed.data.context,
    startedBy: session.sub ?? null,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason,
        existing: {
          id: result.existing.id,
          kind: result.existing.kind,
          startedAt: new Date(result.existing.startedAt).toISOString(),
          startedBy: result.existing.startedBy,
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    sessionId: result.session.id,
    readerId: result.session.readerId,
  });
}
