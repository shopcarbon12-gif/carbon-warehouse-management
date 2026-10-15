import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withActivity } from "@/lib/server/activity-log";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES, isSuperAdminRole } from "@/lib/auth/roles";
import { CountPushError, pushCount } from "@/lib/server/count-review";
import { shortName } from "@/lib/format-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/reports/count-review/push
 *   { reportIds, mode: "add" | "override", confirmZeroCount?, reviveEpcs?, zeroManual? }
 * Pushes the combined count once (see lib/server/count-review.ts). Admin;
 * reviving killed tags is super-admin only.
 */
async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as {
    reportIds?: unknown; mode?: unknown; confirmZeroCount?: unknown; reviveEpcs?: unknown; zeroManual?: unknown;
  };
  const reportIds = Array.isArray(b.reportIds) ? b.reportIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];
  const mode = b.mode === "override" ? "override" : b.mode === "add" ? "add" : null;
  if (!mode) return NextResponse.json({ error: "Choose Add to current stock or Override entire stock." }, { status: 400 });
  const u = await pool
    .query<{ first_name: string | null; last_name: string | null; email: string | null }>(`SELECT first_name, last_name, email FROM users WHERE id = $1::uuid`, [session.sub])
    .catch(() => ({ rows: [] as { first_name: string | null; last_name: string | null; email: string | null }[] }));
  try {
    const result = await pushCount(pool, {
      tenantId: session.tid,
      locationId: session.lid,
      userId: UUID_RE.test(session.sub) ? session.sub : null,
      userName: u.rows[0] ? shortName(u.rows[0].first_name, u.rows[0].last_name, u.rows[0].email) : null,
      isSuperAdmin: isSuperAdminRole(session.role),
      reportIds,
      mode,
      confirmZeroCount: typeof b.confirmZeroCount === "number" ? b.confirmZeroCount : Number(b.confirmZeroCount ?? NaN),
      reviveEpcs: Array.isArray(b.reviveEpcs) ? b.reviveEpcs.filter((x): x is string => typeof x === "string") : [],
      zeroManual: b.zeroManual === true,
    });
    return NextResponse.json({ result });
  } catch (e) {
    if (e instanceof CountPushError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("[reports/count-review/push]", e);
    return NextResponse.json({ error: "The push failed and nothing was changed (the whole push is one transaction)." }, { status: 500 });
  }
}

export const POST = withActivity("reports/count-review/push", POST_handler);
