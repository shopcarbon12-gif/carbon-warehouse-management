/**
 * GET /api/marketing/overview — publish switch, every channel (connected or
 * not yet built) and post counts by status. Admin only.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getMarketingSettings, MARKETING_PROVIDERS, PUBLISHABLE } from "@/lib/server/marketing/store";
import { metaPublishConfigured } from "@/lib/server/marketing/meta";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const tid = g.session.tid;
  const [settings, channels, counts] = await Promise.all([
    getMarketingSettings(g.pool, tid),
    g.pool.query<{ provider: string; account_id: string; name: string; status: string; last_ok_at: Date | null; last_error: string | null }>(
      `SELECT provider, account_id, name, status, last_ok_at, last_error FROM marketing_channels WHERE tenant_id = $1::uuid ORDER BY provider`,
      [tid],
    ),
    g.pool.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM marketing_posts WHERE tenant_id = $1::uuid GROUP BY status`, [tid]),
  ]);
  // Which providers already have server credentials (connected outside the app).
  const env = (k: string) => Boolean(process.env[k]?.trim());
  const CREDS: Record<string, boolean> = {
    instagram: metaPublishConfigured(),
    facebook: metaPublishConfigured(),
    meta_ads: env("META_SYSTEM_USER_TOKEN") && env("META_AD_ACCOUNT_ID"),
    meta_catalog: env("META_SYSTEM_USER_TOKEN") && env("META_CATALOG_ID"),
    google_ads: env("GOOGLE_ADS_REFRESH_TOKEN") && env("GOOGLE_ADS_DEVELOPER_TOKEN"),
    merchant_center: env("GMC_MERCHANT_ID"),
    tiktok: env("TIKTOK_CLIENT_KEY") && env("TIKTOK_CLIENT_SECRET"),
    google_business: env("GOOGLE_BUSINESS_CLIENT_ID") && env("GOOGLE_BUSINESS_CLIENT_SECRET"),
  };
  return NextResponse.json({
    settings,
    providers: MARKETING_PROVIDERS.map((p) => {
      const accounts = channels.rows.filter((c) => c.provider === p.id);
      return {
        ...p,
        publishing: PUBLISHABLE.includes(p.id),
        credentials: CREDS[p.id] ?? false,
        accounts: accounts.map((a) => ({
          accountId: a.account_id,
          name: a.name,
          status: a.status,
          lastOkAt: a.last_ok_at?.toISOString() ?? null,
          lastError: a.last_error,
        })),
      };
    }),
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
  });
}
