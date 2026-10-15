import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withActivity } from "@/lib/server/activity-log";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES, isSuperAdminRole } from "@/lib/auth/roles";
import { listCountFiles, reviewCount } from "@/lib/server/count-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Counts → Combine & review.
 *   GET  → { files } recent Count / Add-On files (newest first, pushed state).
 *   POST { reportIds } → the combined result against the live WMS. Read-only.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const files = await listCountFiles(pool, session.tid);
  return NextResponse.json({ files, isSuperAdmin: isSuperAdminRole(session.role) });
}

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { reportIds?: unknown };
  const reportIds = Array.isArray(body.reportIds) ? body.reportIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];
  if (!reportIds.length) return NextResponse.json({ error: "Pick the count files to combine." }, { status: 400 });
  try {
    const { scannedSet: _omit, ...review } = await reviewCount(pool, { tenantId: session.tid, locationId: session.lid, reportIds });
    void _omit;
    return NextResponse.json({ review, isSuperAdmin: isSuperAdminRole(session.role) });
  } catch (e) {
    console.error("[reports/count-review POST]", e);
    return NextResponse.json({ error: "Could not combine the files." }, { status: 500 });
  }
}

/* Read-only, but wrapped so the history shows who reviewed which count. */
export const POST = withActivity("reports/count-review", POST_handler);
