import { withDb } from "@/lib/db";
import { Share2 } from "lucide-react";

/**
 * WMS → Loyalty → Referrals. Read-only — full edits are at
 * loyalty.shopcarbon.com/admin/referrals.
 */
type Settings = {
  referral_reward_points: number;
  referee_earns_points: number;
  referral_min_purchase: string;
};
type RecentRow = {
  redeemed_at: string;
  referrer_first: string | null;
  referrer_last: string | null;
  referee_first: string | null;
  referee_last: string | null;
  qualifying_amount: string | null;
  shopify_order_gid: string | null;
  pos_sale_id: number | null;
};

export default async function LoyaltyReferrals() {
  const data = await withDb<{
    settings: Settings | null;
    pending: number;
    converted: number;
    recent: RecentRow[];
  }>(
    async (pool) => {
      const [s, p, c, r] = await Promise.all([
        pool.query<Settings>(
          `SELECT referral_reward_points, referee_earns_points,
                  referral_min_purchase::text
             FROM loyalty_settings WHERE id = 1`,
        ),
        pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
             FROM loyalty_referral_redemptions
            WHERE referrer_ledger_id IS NULL`,
        ),
        pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
             FROM loyalty_referral_redemptions
            WHERE referrer_ledger_id IS NOT NULL`,
        ),
        pool.query<RecentRow>(
          `SELECT lrr.redeemed_at,
                  rer.first_name AS referrer_first, rer.last_name AS referrer_last,
                  ree.first_name AS referee_first,  ree.last_name AS referee_last,
                  lrr.qualifying_amount::text,
                  lrr.shopify_order_gid,
                  lrr.pos_sale_id
             FROM loyalty_referral_redemptions lrr
             JOIN loyalty_referrals lr ON lr.id = lrr.referral_id
             LEFT JOIN pos_customers rer ON rer.id = lr.referrer_customer_id
             LEFT JOIN pos_customers ree ON ree.id = lrr.referee_customer_id
            WHERE lrr.referrer_ledger_id IS NOT NULL
            ORDER BY lrr.redeemed_at DESC
            LIMIT 25`,
        ),
      ]);
      return {
        settings: s.rows[0] ?? null,
        pending: Number(p.rows[0]?.n ?? 0),
        converted: Number(c.rows[0]?.n ?? 0),
        recent: r.rows,
      };
    },
    { settings: null, pending: 0, converted: 0, recent: [] },
  );

  const s = data.settings;

  return (
    <main className="p-6 lg:p-8 max-w-6xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Share2 className="h-3.5 w-3.5" />
          Loyalty
        </div>
        <h1 className="text-2xl font-bold mt-1">Referrals</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only summary. Edit rules at{" "}
          <a className="underline" href="https://loyalty.shopcarbon.com/admin/referrals" target="_blank" rel="noreferrer">
            loyalty.shopcarbon.com/admin/referrals ↗
          </a>
          .
        </p>
      </header>

      {s ? (
        <div className="border border-border bg-card p-5 mb-6 max-w-3xl">
          <h2 className="text-base font-bold mb-3">Current rules</h2>
          <ul className="text-sm space-y-1">
            <li>Referrer earns <b>{s.referral_reward_points} pts</b></li>
            <li>Referee earns <b>{s.referee_earns_points} pts</b></li>
            <li>Minimum qualifying purchase <b>${Number(s.referral_min_purchase).toFixed(2)}</b></li>
            <li>Per-conversion payout <b>+{s.referral_reward_points + s.referee_earns_points} pts</b> total</li>
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 max-w-md">
        <Stat label="Converted" value={data.converted.toLocaleString()} />
        <Stat label="Pending" value={data.pending.toLocaleString()} />
      </div>

      <div className="border border-border bg-card overflow-hidden">
        <h2 className="text-base font-bold p-4 border-b border-border">Recent conversions</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wider font-bold">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Referrer</th>
                <th className="text-left px-3 py-2">Referee</th>
                <th className="text-right px-3 py-2">First order</th>
                <th className="text-left px-3 py-2">Order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    No conversions yet.
                  </td>
                </tr>
              ) : (
                data.recent.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(r.redeemed_at).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {[r.referrer_first, r.referrer_last].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {[r.referee_first, r.referee_last].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.qualifying_amount ? `$${Number(r.qualifying_amount).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.shopify_order_gid ?? (r.pos_sale_id ? `pos:${r.pos_sale_id}` : "—")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
