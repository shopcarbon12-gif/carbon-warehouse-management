import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { submitEpcsBatch } from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EPC_RE = /^[0-9A-Fa-f]{24}$/;

/**
 * POST /api/handheld/add-on-sessions/<id>/epcs  (BATCH)
 *
 * The handheld counts each tag locally (instant per-tag counter, no network
 * wait) and flushes buffered reads here in chunks. Each EPC is inserted O(1)
 * into the add_on_session_epcs child table (ON CONFLICT DO NOTHING), so the
 * cost no longer grows with the session size — this is the fix for scanning
 * stalling around ~13–15k EPCs.
 *
 * `inSource: true` reads are dropped server-side (already known from the
 * source list, never count as new). Returns the EPCs that were actually
 * newly-added so the device can reconcile if needed; one aggregated SSE
 * `epc_new` event carries them to other devices in the session.
 */
const batchSchema = z.object({
  deviceId: z.string().min(1).max(256).optional(),
  epcs: z
    .array(
      z.object({
        epc: z.string().regex(EPC_RE, "epc must be 24 hex chars"),
        inSource: z.boolean().optional().default(false),
        validationFailed: z.boolean().optional().default(false),
        failureReason: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(1000),
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
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  // Drop in-source reads (already known, never "new").
  const items = parsed.data.epcs
    .filter((e) => !e.inSource)
    .map((e) => ({
      epc: e.epc.toUpperCase(),
      validationFailed: e.validationFailed,
      failureReason: e.failureReason,
    }));

  if (items.length === 0) {
    return NextResponse.json({ added: [], failedAdded: [], epcCount: null, failedCount: null });
  }

  const result = await submitEpcsBatch(
    pool,
    auth.tenantId,
    id,
    items,
    auth.userId,
    auth.deviceId,
  );
  return NextResponse.json(result);
}
