import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { claudeConfigured, claudeModel } from "@/lib/server/claude";
import { googleConfigured, googleAdsConfigured } from "@/lib/server/google-merchant";
import { metaConfigured } from "@/lib/server/meta-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Integrations → Shopify: the "Translate" and "Sync ads" buttons. Both run in
 * the worker (minutes of Shopify / Claude / Google / Meta calls). GET returns
 * what is connected plus the latest run of each; POST { type } queues one.
 */
const TYPES = { translate: "shopify_translate", ads: "shopify_ads_sync" } as const;
type Kind = keyof typeof TYPES;

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const latest = await pool.query<{ job_type: string; id: string; status: string; finished_at: Date | null; created_at: Date }>(
    `SELECT DISTINCT ON (job_type) job_type, id::text, status, finished_at, created_at
       FROM sync_jobs
      WHERE job_type = ANY($1::text[]) AND tenant_id = $2::uuid
      ORDER BY job_type, created_at DESC`,
    [Object.values(TYPES), session.tid],
  );
  const byType = Object.fromEntries(latest.rows.map((r) => [r.job_type, r]));
  const pick = (k: Kind) => {
    const r = byType[TYPES[k]];
    return r ? { id: r.id, status: r.status, finished_at: r.finished_at?.toISOString() ?? null, created_at: r.created_at.toISOString() } : null;
  };
  return NextResponse.json(
    {
      connected: {
        claude: claudeConfigured(),
        claude_model: claudeModel(),
        google_merchant: googleConfigured(),
        google_ads: googleAdsConfigured(),
        meta: metaConfigured(),
      },
      translate: pick("translate"),
      ads: pick("ads"),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { type?: string; fullTitleCheck?: boolean };
  const kind = body.type === "translate" || body.type === "ads" ? (body.type as Kind) : null;
  if (!kind) return NextResponse.json({ error: "type must be 'translate' or 'ads'" }, { status: 400 });
  const jobType = TYPES[kind];

  // One run of each at a time.
  const active = await pool.query<{ id: string }>(
    `SELECT id::text FROM sync_jobs WHERE job_type = $1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
    [jobType],
  );
  if (active.rows[0]) return NextResponse.json({ job_id: active.rows[0].id, already_running: true });

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
     VALUES ($1::uuid, $2::uuid, $3, 'queued', $4, $5::jsonb)
     RETURNING id::text`,
    [
      session.tid,
      session.lid,
      jobType,
      `${jobType}:${session.tid}:${Date.now()}`,
      JSON.stringify({ trigger: "manual", user_id: session.sub, fullTitleCheck: Boolean(body.fullTitleCheck) }),
    ],
  );
  return NextResponse.json({ job_id: ins.rows[0].id, already_running: false });
}

export const POST = withActivity("shopify/channel-jobs", POST_handler);
