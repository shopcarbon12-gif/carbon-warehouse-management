import { withActivity } from "@/lib/server/activity-log";
/**
 * Studio size fit (owner, 2026-10-24): which size this model wears for this
 * product, from the product's measurements, and how it sits on them
 * (lib/studio-size-fit.ts). Called by every Studio run — regular, Bulk and the
 * night batch — before the panels are built.
 *
 *   POST /api/studio/size-fit { matrixId, modelName, itemSpec?, instruction?, itemType?, productName? }
 *     → { fit: { size, basis, intent, text, summary } | null }   (null = no measurements → no size text)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { studioSizeFit } from "@/lib/server/studio-size-fit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const matrixId = str(b.matrixId, 64);
  const modelName = str(b.modelName, 80).trim();
  if (!UUID_RE.test(matrixId) || !modelName) return NextResponse.json({ error: "matrixId and modelName required" }, { status: 400 });
  try {
    const fit = await studioSizeFit(pool, {
      matrixId,
      modelName,
      itemSpec: str(b.itemSpec, 8000),
      instruction: str(b.instruction, 1200),
      itemType: str(b.itemType, 80),
      productName: str(b.productName, 200),
    });
    return NextResponse.json({ fit });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Size fit failed" }, { status: 500 });
  }
}

export const POST = withActivity("studio/size-fit", POST_handler);
