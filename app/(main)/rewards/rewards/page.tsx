import { withDb } from "@/lib/db";
import { Gift } from "lucide-react";

/**
 * Loyalty → Rewards. Read-only view of the program's reward tiers and
 * the welcome / birthday / referral bonuses. Edit from the loyalty
 * service's admin (link is shown).
 */
export default async function RewardsPage() {
  const settings = await withDb(
    async (pool) => {
      const r = await pool.query<{
        earn_rate_per_dollar: string;
        redeem_points_per_dollar: number;
        redeem_increment_points: number;
        min_redeem_points: number;
        max_redeem_pct_of_order: number;
        coupon_ttl_hours: number;
        signup_bonus_points: number;
        birthday_bonus_points: number;
        referral_reward_points: number;
        points_never_expire: boolean;
      }>(`SELECT earn_rate_per_dollar::text,
                redeem_points_per_dollar,
                redeem_increment_points,
                min_redeem_points,
                max_redeem_pct_of_order,
                coupon_ttl_hours,
                signup_bonus_points,
                birthday_bonus_points,
                referral_reward_points,
                points_never_expire
           FROM loyalty_settings WHERE id = 1`);
      return r.rows[0] ?? null;
    },
    null,
  );

  return (
    <main className="p-6 lg:p-8 max-w-3xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Gift className="h-3.5 w-3.5" />
          Rewards
        </div>
        <h1 className="text-2xl font-bold mt-1">Rewards</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only here. Edit at{" "}
          <a className="underline" href="https://rewards.shopcarbon.com/admin/settings" target="_blank" rel="noreferrer">
            rewards.shopcarbon.com/admin/settings
          </a>.
        </p>
      </header>

      {!settings ? (
        <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
          No settings row yet — the loyalty service hasn&rsquo;t deployed
          its first migration.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card title="Earn rate" value={`${Number(settings.earn_rate_per_dollar)} pt per $1`} />
          <Card
            title="Redemption tier"
            value={`${settings.redeem_increment_points} pts → $${(settings.redeem_increment_points / settings.redeem_points_per_dollar).toFixed(2)} off`}
            note={`Multiples of ${settings.redeem_increment_points} pts · max ${settings.max_redeem_pct_of_order}% of subtotal · coupon expires in ${settings.coupon_ttl_hours}h`}
          />
          <Card title="Welcome bonus" value={`${settings.signup_bonus_points} pts`} />
          <Card title="Birthday bonus" value={`${settings.birthday_bonus_points} pts`} note="Once per calendar year" />
          <Card title="Referral reward" value={`${settings.referral_reward_points} pts`} note="Awarded to the referrer when the referee signs up" />
          <Card
            title="Expiry"
            value={settings.points_never_expire ? "Never" : "(time-bound)"}
          />
        </div>
      )}
    </main>
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
