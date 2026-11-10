/**
 * GET /api/creative/radar/<id> — one Radar ad: player + variations, tags, score breakdown,
 * hook / copy / transcript / shot list, landing page, Similar ads. Admin only (private research).
 */
import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/server/creative/http";
import { adDetail, similarAds } from "@/lib/server/creative/radar/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const ad = await adDetail(g.pool, g.session.tid, id);
    if (!ad) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ad, similar: await similarAds(g.pool, g.session.tid, id) });
  } catch (e) {
    return fail(e);
  }
}
