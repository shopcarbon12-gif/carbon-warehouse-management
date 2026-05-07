import Link from "next/link";
import { withDb } from "@/lib/db";
import { Activity } from "lucide-react";

const PAGE_SIZE = 100;
const REASONS = [
  "sale", "redemption", "refund",
  "signup_bonus", "birthday_bonus", "referral_bonus",
  "manual", "adjustment", "migration",
] as const;

/**
 * Loyalty → Ledger. Mirrors loyalty.shopcarbon.com/admin/ledger but
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
    <main className="p-6 lg:p-8 max-w-7xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Loyalty
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

      <div className="border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase tracking-wider font-bold">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Customer</th>
              <th className="text-right px-3 py-2">Δ Pts</th>
              <th className="text-left px-3 py-2">Reason</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Ref</th>
              <th className="text-right px-3 py-2">Basis</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No ledger rows match.</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    {row.customer_id ? (
                      <Link className="underline" href={`/loyalty/customers/${row.customer_id}`}>
                        {row.customer_name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{row.customer_name}</span>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${row.delta_points > 0 ? "text-emerald-600" : "text-rose-700"}`}>
                    {row.delta_points > 0 ? "+" : ""}{row.delta_points}
                  </td>
                  <td className="px-3 py-2">{row.reason}</td>
                  <td className="px-3 py-2">{row.source}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.source_ref ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.amount_basis ? `$${Number(row.amount_basis).toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <Link className="px-3 py-1 border border-border" href={`?reason=${reason}&page=${Math.max(1, page - 1)}`}>Prev</Link>
        <span className="text-muted-foreground">Page {page}</span>
        <Link className="px-3 py-1 border border-border" href={`?reason=${reason}&page=${page + 1}`}>Next</Link>
      </div>
    </main>
  );
}
