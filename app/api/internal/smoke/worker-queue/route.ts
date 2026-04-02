import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

const HDR = "x-wms-smoke-secret";

function smokeSecret(): string {
  let s = process.env.WMS_OPS_SMOKE_SECRET?.trim() ?? "";
  /* Coolify / bulk env API sometimes persists a literal quoted string; strip one matching outer pair. */
  if (
    s.length >= 2 &&
    ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function authorized(req: Request): boolean {
  const s = smokeSecret();
  if (!s) return false;
  return req.headers.get(HDR) === s;
}

/**
 * Ops-only: enqueue a stub `reconcile` job when `WMS_OPS_SMOKE_SECRET` is set in the container.
 * Protected by `x-wms-smoke-secret` header (not a session). Disabled when env unset (404).
 */
export async function POST(req: Request) {
  if (!smokeSecret()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const idempotencyKey = `wms-ops-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

  try {
    const loc = await pool.query(`SELECT l.id AS location_id, l.tenant_id FROM locations l LIMIT 1`);
    const row = loc.rows[0];
    if (!row) {
      return NextResponse.json({ error: "No location row" }, { status: 500 });
    }

    const ins = await pool.query(
      `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
       VALUES ($1::uuid, $2::uuid, 'reconcile', 'queued', $3, $4::jsonb)
       RETURNING id::text`,
      [row.tenant_id, row.location_id, idempotencyKey, JSON.stringify({ source: "wms_ops_smoke_api" })],
    );

    return NextResponse.json({
      ok: true,
      job_id: ins.rows[0]?.id,
      idempotency_key: idempotencyKey,
    });
  } catch (e) {
    console.error("[internal/smoke/worker-queue] POST", e);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  if (!smokeSecret()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("idempotency_key")?.trim();
  if (!key) {
    return NextResponse.json({ error: "idempotency_key query required" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const r = await pool.query(
      `SELECT id::text, status, error, attempts FROM sync_jobs WHERE idempotency_key = $1 LIMIT 1`,
      [key],
    );
    const row = r.rows[0];
    if (!row) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({
      job_id: row.id,
      status: row.status,
      error: row.error,
      attempts: row.attempts,
    });
  } catch (e) {
    console.error("[internal/smoke/worker-queue] GET", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
