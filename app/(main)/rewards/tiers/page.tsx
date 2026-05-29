import { withDb } from "@/lib/db";
import { Layers } from "lucide-react";

/**
 * WMS → Loyalty → Tiers. Read-only mirror of the tier program — edits
 * happen at rewards.shopcarbon.com/admin/tiers so the loyalty service
 * is the system of record.
 */
type TierRow = {
  code: string;
  name: string;
  qualifying_points: number;
  earn_multiplier: string;
  perks: unknown;
};

type Settings = {
  tier_batch_hour_est: number | null;
  tier_qualifying_metric: string | null;
};

const TIER_BORDER: Record<string, string> = {
  bronze: "border-t-[#b48a40]",
  silver: "border-t-[#8a8a8a]",
  gold: "border-t-[#d4af37]",
  vip: "border-t-[#6d28d9]",
};

export default async function LoyaltyTiers() {
  const data = await withDb<{ tiers: TierRow[]; dist: Record<string, number>; settings: Settings | null; total: number }>(
    async (pool) => {
      const [t, d, s] = await Promise.all([
        pool.query<TierRow>(
          `SELECT code, name, qualifying_points, earn_multiplier::text, perks
             FROM loyalty_tiers ORDER BY sort_order ASC`,
        ),
        pool.query<{ code: string | null; n: string }>(
          `WITH lifetime AS (
             SELECT customer_id,
                    SUM(CASE WHEN delta_points > 0 THEN delta_points ELSE 0 END) AS pts
               FROM loyalty_ledger WHERE customer_id IS NOT NULL
               GROUP BY customer_id
           )
           SELECT
             (SELECT t.code FROM loyalty_tiers t
               WHERE t.qualifying_points <= COALESCE(lifetime.pts, 0)
               ORDER BY t.qualifying_points DESC LIMIT 1) AS code,
             COUNT(*)::text AS n
             FROM lifetime
             GROUP BY code`,
        ),
        pool.query<Settings>(
          `SELECT tier_batch_hour_est, tier_qualifying_metric FROM loyalty_settings WHERE id = 1`,
        ),
      ]);
      const dist: Record<string, number> = {};
      for (const r of d.rows) {
        if (r.code) dist[r.code] = Number(r.n);
      }
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      return { tiers: t.rows, dist, settings: s.rows[0] ?? null, total };
    },
    { tiers: [], dist: {}, settings: null, total: 0 },
  );

  return (
    <main className="p-6 lg:p-8 max-w-6xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          Rewards
        </div>
        <h1 className="text-2xl font-bold mt-1">Tier program</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only view. Edit at{" "}
          <a className="underline" href="https://rewards.shopcarbon.com/admin/tiers" target="_blank" rel="noreferrer">
            rewards.shopcarbon.com/admin/tiers ↗
          </a>
          .
        </p>
      </header>

      {data.settings ? (
        <div className="border border-border bg-card p-5 mb-6">
          <h2 className="text-base font-bold mb-2">Program-level</h2>
          <div className="text-sm space-y-1">
            <p>Qualifying metric: <b>lifetime {data.settings.tier_qualifying_metric}</b></p>
            <p>Batch run hour: <b>{data.settings.tier_batch_hour_est} EST daily</b></p>
            <p>Customers tiered: <b>{data.total.toLocaleString()}</b></p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {data.tiers.map((t) => {
          const n = data.dist[t.code] ?? 0;
          const pct = data.total > 0 ? Math.round((n / data.total) * 1000) / 10 : 0;
          return (
            <div
              key={t.code}
              className={`border border-border bg-card p-4 border-t-4 ${TIER_BORDER[t.code] ?? ""}`}
            >
              <h3 className="text-lg font-bold">{t.name}</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Lifetime {t.qualifying_points.toLocaleString()}+ pts
              </p>
              <p className="text-2xl font-bold tabular-nums mt-3">{Number(t.earn_multiplier).toFixed(2)}×</p>
              <p className="text-[11px] text-muted-foreground">earn multiplier</p>
              <p className="text-sm mt-3">
                <b>{n.toLocaleString()}</b>{" "}
                <span className="text-muted-foreground">customers · {pct}%</span>
              </p>
              {Array.isArray(t.perks) ? (
                <ul className="text-xs mt-2 list-disc list-inside text-muted-foreground">
                  {(t.perks as string[]).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </main>
  );
}
