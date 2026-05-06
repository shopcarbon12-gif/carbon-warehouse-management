import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { startSession, janitorIdleSessions } from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/handheld/add-on-sessions
 *
 * Start an Add-On Count session against a source. Acquires the source-row
 * lock atomically. Body:
 *   sourceType: 'mobile_count' | 'cycle_count' | 'csv_import'
 *   sourceId:   uuid (mobile/cycle) or int-as-string (csv)
 *   sourceSlip: 5-digit slip from the picker
 *   deviceId?:  edge-key auth path
 */

const startSchema = z.object({
  sourceType: z.enum(["mobile_count", "cycle_count", "csv_import"]),
  sourceId: z.string().min(1).max(64),
  sourceSlip: z.string().min(1).max(32),
  deviceId: z.string().min(1).max(256).optional(),
});

export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Best-effort cleanup: clear idle sessions before trying to acquire a new lock.
  janitorIdleSessions(pool).catch(() => {});

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  try {
    const session = await startSession(pool, {
      tenantId: auth.tenantId,
      sourceType: parsed.data.sourceType,
      sourceId: parsed.data.sourceId,
      sourceSlip: parsed.data.sourceSlip,
      ownerUserId: auth.userId,
      ownerDeviceId: auth.deviceId,
    });
    if (!session) {
      return NextResponse.json(
        { error: "Source is locked by another session or already completed" },
        { status: 409 },
      );
    }
    return NextResponse.json(session, { status: 201 });
  } catch (e) {
    console.error("[add-on-sessions POST]", e);
    return NextResponse.json({ error: "Start failed" }, { status: 500 });
  }
}
