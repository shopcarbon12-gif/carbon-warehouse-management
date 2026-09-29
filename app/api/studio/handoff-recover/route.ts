/**
 * Photos a phone sent for this product that no desktop ever collected — a
 * QR panel closed early, a tab discarded, a deploy in between. Admin-only.
 *
 *   GET /api/studio/handoff-recover?matrixId=<uuid>          → { count }
 *   GET /api/studio/handoff-recover?matrixId=<uuid>&take=1   → { count, images: [{imageId, imageUrl}] } (marks them collected)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { recoverHandoffImagesForMatrix } from "@/lib/image-handoff-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const url = new URL(req.url);
  const matrixId = String(url.searchParams.get("matrixId") || "").trim();
  if (!UUID_RE.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const take = url.searchParams.get("take") === "1";
  try {
    const r = await recoverHandoffImagesForMatrix(matrixId, take);
    return NextResponse.json({
      count: r.count,
      images: r.images.map((img) => ({ imageId: img.id, imageUrl: img.url })),
    });
  } catch (e) {
    console.error("[handoff-recover] failed:", (e as Error)?.message || e);
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}
