import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  skus: z.array(z.string().min(1).max(256)).max(5000).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * Records a **push intent** in `sync_jobs` for audit / future LS inventory API wiring.
 * Does not call Lightspeed write APIs yet (account-specific inventory endpoints).
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) raw = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const skus = parsed.data.skus ?? [];
  const idempotency_key = `ls-push-${randomUUID()}`;

  try {
    await pool.query(
      `INSERT INTO sync_jobs (
         tenant_id, location_id, job_type, status, idempotency_key, payload, error, attempts, updated_at
       )
       VALUES ($1::uuid, $2::uuid, 'lightspeed_push', 'completed', $3, $4::jsonb, NULL, 0, now())`,
      [
        session.tid,
        session.lid,
        idempotency_key,
        JSON.stringify({
          skus,
          note: parsed.data.note ?? null,
          recorded_at: new Date().toISOString(),
          user_id: session.sub,
          implementation: "stub_record_only",
          stub_message:
            "Awaiting Lightspeed inventory write API integration (adjustments / transfers / shop-scoped qty).",
        }),
      ],
    );

    return NextResponse.json({
      ok: true,
      stub: true,
      job_key: idempotency_key,
      sku_count: skus.length,
      message:
        "Recorded push request in sync history. No outbound Lightspeed API call yet — wire account-specific inventory endpoints when ready.",
    });
  } catch (e) {
    console.error("[integrations/lightspeed/push]", e);
    return NextResponse.json({ error: "Could not record push" }, { status: 500 });
  }
}
