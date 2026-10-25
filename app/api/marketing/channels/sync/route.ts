import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/marketing/channels/sync — read the Facebook pages and linked
 * Instagram accounts the Meta token manages and save them as channels.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { discoverMetaAccounts, metaPublishConfigured } from "@/lib/server/marketing/meta";

export const dynamic = "force-dynamic";

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  if (!metaPublishConfigured()) return NextResponse.json({ error: "META_SYSTEM_USER_TOKEN is not set on this server" }, { status: 503 });
  let accounts;
  try {
    accounts = await discoverMetaAccounts();
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const upsert = (provider: string, accountId: string, name: string) =>
    g.pool.query(
      `INSERT INTO marketing_channels (tenant_id, provider, account_id, name, status, last_ok_at) VALUES ($1::uuid, $2, $3, $4, 'connected', now())
       ON CONFLICT (tenant_id, provider, account_id) DO UPDATE SET name = EXCLUDED.name, status = 'connected', last_ok_at = now(), last_error = NULL`,
      [g.session.tid, provider, accountId, name],
    );
  for (const a of accounts) {
    await upsert("facebook", a.pageId, a.pageName);
    if (a.igUserId) await upsert("instagram", a.igUserId, a.igUsername ? `@${a.igUsername}` : a.pageName);
  }
  return NextResponse.json({ accounts });
}

export const POST = withActivity("marketing/channels/sync", POST_handler);
