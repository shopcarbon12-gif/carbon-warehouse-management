import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { describeMatrix, lookupCode, UUID_RE } from "@/lib/server/grading-app";

export const dynamic = "force-dynamic";

/**
 * GET ?code=<hang-tag barcode | SKU | UPC>  or  ?matrixId=<uuid>
 * → the item, its sizes and colours, its cut group and the garment type the
 *   phone should measure it as.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const sp = new URL(req.url).searchParams;
  const matrixId = (sp.get("matrixId") ?? "").trim();
  const code = (sp.get("code") ?? "").trim();
  if (matrixId && !UUID_RE.test(matrixId)) return NextResponse.json({ error: "matrixId must be a uuid" }, { status: 400 });
  if (!matrixId && !code) return NextResponse.json({ error: "code or matrixId required" }, { status: 400 });
  const found = matrixId ? await describeMatrix(pool, matrixId) : await lookupCode(pool, code);
  if (!found) return NextResponse.json({ error: `Nothing in the WMS matches "${code || matrixId}".` }, { status: 404 });
  return NextResponse.json(found);
}
