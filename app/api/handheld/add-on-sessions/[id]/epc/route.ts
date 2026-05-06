import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { submitEpc, recordFailedEpc } from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EPC_RE = /^[0-9A-Fa-f]{24}$/;

/**
 * POST /api/handheld/add-on-sessions/<id>/epc
 *
 * Submit an EPC read. Server consults the in-source EPC list (loaded by the
 * device on session start), then dedupes against the session ledger. The
 * outcome dictates beep / no-beep on the device:
 *   new        → beep + counter +1; broadcast 'epc_new' via SSE so other devices ignore it
 *   duplicate  → silent (already in source OR already counted by another device)
 *   failed     → silent (failed system-id validation; recorded for UPLOAD)
 *
 * The device passes `inSource: true` for tags it found in the loaded
 * source list so the server can short-circuit without ledger writes
 * — those don't count as "new" anyway.
 */
const epcSchema = z.object({
  epc: z.string().regex(EPC_RE, "epc must be 24 hex chars"),
  inSource: z.boolean().optional().default(false),
  validationFailed: z.boolean().optional().default(false),
  failureReason: z.string().max(64).optional(),
  deviceId: z.string().min(1).max(256).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = epcSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  const epc = parsed.data.epc.toUpperCase();

  if (parsed.data.validationFailed) {
    await recordFailedEpc(
      pool,
      auth.tenantId,
      id,
      epc,
      parsed.data.failureReason ?? "device_decode_failed",
      auth.userId,
      auth.deviceId,
    );
    return NextResponse.json({ outcome: "failed" });
  }

  if (parsed.data.inSource) {
    // No ledger write — already known from the source list. Counter ignores.
    return NextResponse.json({ outcome: "duplicate", inSource: true });
  }

  const result = await submitEpc(
    pool,
    auth.tenantId,
    id,
    epc,
    auth.userId,
    auth.deviceId,
  );
  return NextResponse.json(result);
}
