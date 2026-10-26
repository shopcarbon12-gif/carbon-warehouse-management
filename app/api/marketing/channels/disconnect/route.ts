import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/marketing/channels/disconnect { provider, accountId } — stop
 * publishing to one connected account. Nothing is deleted: Instagram and
 * Facebook come back with "Sync Meta accounts", Bluesky by connecting again.
 * Approved posts for that channel wait (approval needs it connected).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";

export const dynamic = "force-dynamic";

const schema = z.object({ provider: z.string().min(1).max(40), accountId: z.string().min(1).max(200) }).strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Which account?" }, { status: 400 });
  const r = await g.pool.query(
    `UPDATE marketing_channels SET status = 'disconnected', secret = NULL WHERE tenant_id = $1::uuid AND provider = $2 AND account_id = $3`,
    [g.session.tid, parsed.data.provider, parsed.data.accountId],
  );
  if (!r.rowCount) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const POST = withActivity("marketing/channels/disconnect", POST_handler);
