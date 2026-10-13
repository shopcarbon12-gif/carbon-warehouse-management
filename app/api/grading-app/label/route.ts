import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { saveLabelDetails, UUID_RE } from "@/lib/server/grading-app";

/**
 * POST {matrixId, fabric?, care?} — fabric / care read off a care label on the
 * phone, for a product the WMS has none for. Fills gaps only; values already
 * in the WMS are kept. The next product-details sync carries them to Shopify.
 */
const Body = z.object({
  matrixId: z.string().regex(UUID_RE),
  fabric: z.string().trim().min(3).max(200).nullish(),
  care: z.string().trim().min(3).max(500).nullish(),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const out = await saveLabelDetails(pool, parsed.data.matrixId, parsed.data.fabric ?? null, parsed.data.care ?? null);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, fabric: out.fabric, care: out.care });
}

export const POST = withActivity("grading-app/label", POST_handler);
