import Link from "next/link";
import { withDb } from "@/lib/db";
import { Activity } from "lucide-react";
import { LoyaltyLedgerTable } from "@/components/loyalty/ledger-table";

const PAGE_SIZE = 100;
const REASONS = [
  "sale", "redemption", "refund",
  "signup_bonus", "birthday_bonus", "referral_bonus",
  "manual", "adjustment", "migration",
] as const;

/**
 * Loyalty → Ledger. Mirrors rewards.shopcarbon.com/admin/ledger but
 * inside the WMS shell. Filterable by reason, paged.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const reason = sp.reason ?? "";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await withDb(
    async (pool) => {
      const args: unknown[] = [];
      let where = "";
      if (reason) {
        args.push(reason);
        where = `WHERE l.reason = $1`;
      }
      args.push(PAGE_SIZE, offset);
      const idxL = args.length - 1;
      const idxO = args.length;
      const r = await pool.query(
        `SELECT l.id::text,
                l.delta_points,
                l.reason,
                l.source,
                l.source_ref,
                l.amount_basis::text,
                l.created_at,
                COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), '(no customer)') AS customer_name,
                l.customer_id
           FROM loyalty_ledger l
           LEFT JOIN pos_customers c ON c.id = l.customer_id
           ${where}
          ORDER BY l.created_at DESC
          LIMIT $${idxL}::int OFFSET $${idxO}::int`,
        args,
      );
      return r.rows;
    },
    [],
  );

  return (
    <main className="p-6 lg:p-8 max-w-7xl max-md:p-4">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Rewards
        </div>
        <h1 className="text-2xl font-bold mt-1">Ledger</h1>
      </header>

      <form className="flex gap-2 items-end mb-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Reason</span>
          <select name="reason" defaultValue={reason} className="border border-border bg-card px-3 py-2">
            <option value="">All</option>
            {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button type="submit" className="border border-border bg-card hover:bg-muted px-4 py-2 text-sm font-semibold">Apply</button>
      </form>

      <LoyaltyLedgerTable rows={rows} />

      <div className="mt-3 flex items-center gap-2 text-sm">
        <Link className="px-3 py-1 border border-border max-md:py-2" href={`?reason=${reason}&page=${Math.max(1, page - 1)}`}>Prev</Link>
        <span className="text-muted-foreground">Page {page}</span>
        <Link className="px-3 py-1 border border-border max-md:py-2" href={`?reason=${reason}&page=${page + 1}`}>Next</Link>
      </div>
    </main>
  );
}
