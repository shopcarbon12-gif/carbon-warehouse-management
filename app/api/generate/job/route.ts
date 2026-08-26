import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { claimGenerateJob, isValidJobId, releaseGenerateJob } from "@/lib/server/generate-jobs";

/**
 * Claim the result of a detached Carbon Studio panel generation.
 *
 * The Studio tab calls this when its original `/api/generate` connection died
 * (app switch, phone lock, tab discarded, WebView frozen) — the render itself
 * kept running server-side. Same admin gate as `/api/generate`.
 *
 * GET  ?id=<jobId> → { status: "running" } | { status: "missing" } | the panel body
 * DELETE ?id=<jobId> → drop a parked body the client already received.
 */
export const dynamic = "force-dynamic";

async function guard(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  return requireSessionScopes(pool, session, [SCOPES.ADMIN]);
}

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!isValidJobId(id)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });

  const claimed = claimGenerateJob(id);
  if (claimed.status === "missing") {
    // Expired, already claimed, or the server restarted mid-run.
    return NextResponse.json({ status: "missing" }, { status: 404 });
  }
  if (claimed.status === "running") {
    return NextResponse.json({ status: "running" }, { headers: { "Cache-Control": "no-store" } });
  }
  // The parked body is the panel response verbatim; hand it back with a status marker.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(claimed.body) as Record<string, unknown>;
  } catch {
    payload = { error: "Generation result was unreadable" };
  }
  return NextResponse.json({ status: "done", ...payload }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!isValidJobId(id)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  releaseGenerateJob(id);
  return NextResponse.json({ ok: true });
}
