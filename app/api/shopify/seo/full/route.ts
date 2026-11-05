import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { claudeConfigured } from "@/lib/server/claude";
import { enqueueSeoFull } from "@/lib/server/seo-full";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full SEO pass for one product (lib/server/seo-full.ts) — the SEO tab panel.
 *   GET  ?matrixId=…        → the product's latest runs (status, notes, colour suggestions)
 *   POST { matrixId }       → queue a run now
 */
async function productOf(matrixId: string) {
  const pool = getPool()!;
  const r = await pool.query<{ shopify_product_id: string | null }>(`SELECT shopify_product_id FROM matrices WHERE id=$1::uuid`, [matrixId]);
  return r.rows[0]?.shopify_product_id ?? null;
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const matrixId = new URL(req.url).searchParams.get("matrixId") || "";
  if (!/^[0-9a-f-]{36}$/i.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const productId = await productOf(matrixId);
  if (!productId) return NextResponse.json({ runs: [], configured: claudeConfigured() });
  const r = await pool.query(
    `SELECT r.id::text, r.status, r.trigger, r.created_at, r.finished_at, r.error,
            r.result->'output'->'colourFix' AS colour_fix,
            r.result->'output'->>'ownerNotes' AS owner_notes,
            r.result->'output'->>'confidence' AS confidence,
            r.result->'done' AS done,
            r.result->'issues' AS issues,
            j.progress_message
       FROM seo_full_runs r LEFT JOIN sync_jobs j ON j.id = r.job_id
      WHERE r.shopify_product_id = $1 AND r.tenant_id = $2::uuid
      ORDER BY r.created_at DESC LIMIT 5`,
    [productId, session.tid],
  );
  return NextResponse.json({ runs: r.rows, configured: claudeConfigured() });
}

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { matrixId?: string };
  const matrixId = String(body.matrixId || "");
  if (!/^[0-9a-f-]{36}$/i.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "AI is not configured (ANTHROPIC_API_KEY)." }, { status: 503 });
  const productId = await productOf(matrixId);
  if (!productId) return NextResponse.json({ error: "Publish this product to Shopify first." }, { status: 400 });
  const q = await enqueueSeoFull(pool, { tenantId: session.tid, locationId: session.lid, productId, matrixId, trigger: "manual" });
  return NextResponse.json({ ok: true, ...q });
}

export const POST = withActivity("shopify/seo/full", POST_handler);
