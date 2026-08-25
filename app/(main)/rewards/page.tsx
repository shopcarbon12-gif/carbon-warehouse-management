import Link from "next/link";
import { withDb } from "@/lib/db";
import { Star, Users, TrendingUp, Activity } from "lucide-react";

// KPIs are live shared-DB reads — never statically cache this page, or it
// would drift from rewards.shopcarbon.com/admin (which is force-dynamic too).
export const dynamic = "force-dynamic";

/**
 * Loyalty → Overview. Top-level dashboard mirroring what
 * rewards.shopcarbon.com/admin shows, but rendered inside the WMS shell
 * so back-office staff don't context-switch.
 *
 * All ledger reads come from the SHARED Postgres directly — WMS doesn't
 * have to traverse the rewards.shopcarbon.com HTTP API just to display
 * numbers. Writes (manual adjustments) DO go through the API so the
 * idempotency table catches double-clicks.
 */
type SettingsRow = {
  earn_rate_per_dollar: string;
  redeem_points_per_dollar: number;
  redeem_increment_points: number;
  max_redeem_pct_of_order: number;
  coupon_ttl_hours: number;
  live: boolean;
  signup_bonus_points: number;
  birthday_bonus_points: number;
  referral_reward_points: number;
  points_never_expire: boolean;
};
type Stats = {
  members: number;
  awarded: number;
  redeemed: number;
  settings: SettingsRow | null;
};

export default async function LoyaltyOverview() {
  const stats = await withDb<Stats>(
    async (pool) => {
      const [kpi, settings] = await Promise.all([
        // Single source of truth shared with rewards.shopcarbon.com/admin
        // (loyalty_kpi_summary, defined by the loyalty service's migration
        // 005). Don't hand-roll the SUMs here — that's what made the two
        // dashboards disagree (WMS used to count manual adjustments as
        // awarded). Read the view so the definition lives in one place.
        pool.query<{ members: string; awarded: string; redeemed: string }>(
          `SELECT members::text          AS members,
                  points_awarded::text   AS awarded,
                  points_redeemed::text  AS redeemed
             FROM loyalty_kpi_summary`,
        ),
        pool.query<{
          earn_rate_per_dollar: string;
          redeem_points_per_dollar: number;
          redeem_increment_points: number;
          max_redeem_pct_of_order: number;
          coupon_ttl_hours: number;
          live: boolean;
          signup_bonus_points: number;
          birthday_bonus_points: number;
          referral_reward_points: number;
          points_never_expire: boolean;
        }>(
          `SELECT earn_rate_per_dollar::text,
                  redeem_points_per_dollar,
                  redeem_increment_points,
                  max_redeem_pct_of_order,
                  coupon_ttl_hours,
                  live,
                  signup_bonus_points,
                  birthday_bonus_points,
                  referral_reward_points,
                  points_never_expire
             FROM loyalty_settings WHERE id = 1`,
        ),
      ]);
      return {
        members: Number(kpi.rows[0]?.members ?? 0),
        awarded: Number(kpi.rows[0]?.awarded ?? 0),
        redeemed: Number(kpi.rows[0]?.redeemed ?? 0),
        settings: settings.rows[0] ?? null,
      };
    },
    { members: 0, awarded: 0, redeemed: 0, settings: null },
  );

  const live = stats.settings?.live ?? false;

  return (
    <main className="p-6 lg:p-8 max-w-6xl max-md:p-4">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Star className="h-3.5 w-3.5" />
          Rewards
        </div>
        <h1 className="text-2xl font-bold mt-1">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live program data from the shared Postgres ledger. All write
          operations route through <code>rewards.shopcarbon.com</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat icon={Users} label="Members" value={stats.members.toLocaleString()} />
        <Stat icon={TrendingUp} label="Points awarded" value={stats.awarded.toLocaleString()} />
        <Stat icon={Activity} label="Points redeemed" value={stats.redeemed.toLocaleString()} />
        <Stat
          icon={Star}
          label="Live switch"
          value={live ? "ON" : "OFF"}
          tone={live ? "good" : "muted"}
        />
      </div>

      {stats.settings ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
            <Card title="Earn rate" value={`${Number(stats.settings.earn_rate_per_dollar)} pt per $1`} />
            <Card
              title="Redemption tier"
              value={`${stats.settings.redeem_increment_points} pts → $${(stats.settings.redeem_increment_points / stats.settings.redeem_points_per_dollar).toFixed(2)} off`}
              note={`Multiples of ${stats.settings.redeem_increment_points} pts · max ${stats.settings.max_redeem_pct_of_order}% of subtotal · coupon expires in ${stats.settings.coupon_ttl_hours}h`}
            />
            <Card title="Welcome bonus" value={`${stats.settings.signup_bonus_points} pts`} />
            <Card title="Birthday bonus" value={`${stats.settings.birthday_bonus_points} pts`} note="Once per calendar year" />
            <Card title="Referral reward" value={`${stats.settings.referral_reward_points} pts`} note="Awarded to the referrer when the referee signs up" />
            <Card title="Expiry" value={stats.settings.points_never_expire ? "Never" : "(time-bound)"} />
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Edit at{" "}
            <a className="underline" href="https://rewards.shopcarbon.com/admin/settings" target="_blank" rel="noreferrer">
              rewards.shopcarbon.com/admin/settings
            </a>
            .
          </p>
        </>
      ) : (
        <div className="border border-border bg-card p-6 max-w-3xl">
          <p className="text-sm text-muted-foreground">
            Rewards schema is not yet present in this database — the
            loyalty service hasn&rsquo;t deployed its first migration.
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/rewards/customers" className="px-4 py-2 border border-border bg-card hover:bg-muted text-sm font-semibold">
          Browse members →
        </Link>
        <Link href="/rewards/ledger" className="px-4 py-2 border border-border bg-card hover:bg-muted text-sm font-semibold">
          Recent ledger →
        </Link>
        <a
          href="https://rewards.shopcarbon.com/admin"
          target="_blank"
          rel="noreferrer"
          className="px-4 py-2 border border-border bg-card hover:bg-muted text-sm font-semibold"
        >
          Rewards admin ↗
        </a>
      </div>
    </main>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: "good" | "muted";
}) {
  const valueCls =
    tone === "good"
      ? "text-emerald-600"
      : tone === "muted"
        ? "text-muted-foreground"
        : "";
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-bold text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={`text-2xl font-bold mt-2 ${valueCls}`}>{value}</p>
    </div>
  );
}

function Card({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className="border border-border bg-card p-5">
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{title}</div>
      <div className="text-xl font-bold mt-2">{value}</div>
      {note ? <p className="text-xs text-muted-foreground mt-2">{note}</p> : null}
    </div>
  );
}
