import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { performLightspeedCatalogSync } from "@/lib/server/lightspeed-sync";

export const dynamic = "force-dynamic";

/**
 * Refreshes catalog matrices + variant lines and updates `custom_skus.ls_on_hand_total`
 * from Lightspeed when the live catalog API returns on-hand fields (same pipeline as **Sync Lightspeed**).
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const idempotency_key = `ls-pull-${randomUUID()}`;
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO sync_jobs (
         tenant_id, location_id, job_type, status, idempotency_key, payload
       )
       VALUES ($1::uuid, $2::uuid, 'lightspeed_catalog', 'running', $3, $4::jsonb)
       RETURNING id::text`,
      [
        session.tid,
        session.lid,
        idempotency_key,
        JSON.stringify({
          trigger: "integrations_pull",
          user_id: session.sub,
          started_at: new Date().toISOString(),
        }),
      ],
    );
    const job_id = ins.rows[0]?.id;
    if (!job_id) {
      return NextResponse.json({ error: "Could not create sync job" }, { status: 500 });
    }

    const result = await performLightspeedCatalogSync(pool, job_id, session.tid, session.sub);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, job_id: result.job_id, stub: false },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      stub: false,
      job_id: result.job_id,
      records_updated: result.records_updated,
      source: result.source,
      warnings: result.warnings,
      message:
        result.source === "live"
          ? "Pulled catalog from Lightspeed; on-hand fields applied when present in API."
          : "Catalog updated from simulated payload (live API unavailable or not configured).",
    });
  } catch (e) {
    console.error("[integrations/lightspeed/pull]", e);
    return NextResponse.json({ error: "Pull failed" }, { status: 500 });
  }
}
