/**
 * GET /api/marketing/channels/tiktok/creator — the connected TikTok account as
 * TikTok describes it right now (name, picture, which privacy settings and
 * interactions it allows), for the "Post to TikTok" box on a Social post.
 * { connected: false } when no TikTok account is connected.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { tiktokCreator } from "@/lib/server/marketing/tiktok";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const c = await g.pool.query(`SELECT 1 FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'tiktok' AND status = 'connected' LIMIT 1`, [g.session.tid]);
  if (!c.rowCount) return NextResponse.json({ connected: false });
  try {
    return NextResponse.json({ connected: true, creator: await tiktokCreator(g.pool, g.session.tid) });
  } catch (e) {
    return NextResponse.json({ connected: true, error: e instanceof Error ? e.message : "TikTok did not answer" }, { status: 502 });
  }
}
