import Link from "next/link";
import { withDb } from "@/lib/db";
import { UserSearch } from "lucide-react";

const PAGE_SIZE = 50;

/**
 * Loyalty → Members. Lists every pos_customers row, joined to the
 * loyalty_balance view so admins can scan balances at a glance and
 * drill into one for adjustments.
 */
export default async function LoyaltyMembers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { rows, total } = await withDb(
    async (pool) => {
      const args: unknown[] = [];
      let where = "";
      if (q) {
        args.push(`%${q}%`);
        where = `WHERE pc.first_name ILIKE $1
                    OR pc.last_name ILIKE $1
                    OR pc.email ILIKE $1
                    OR pc.mobile_phone ILIKE $1
                    OR pc.phone ILIKE $1`;
      }
      const idx0 = args.length;
      args.push(PAGE_SIZE, offset);
      const r = await pool.query<{
        id: number;
        first_name: string;
        last_name: string | null;
        email: string | null;
        mobile_phone: string | null;
        phone: string | null;
        balance: string;
        last_event_at: string | null;
        shopify_customer_gid: string | null;
      }>(
        `SELECT pc.id,
                pc.first_name,
                pc.last_name,
                pc.email,
                pc.mobile_phone,
                pc.phone,
                COALESCE(lb.balance, 0)::text AS balance,
                lb.last_event_at,
                pc.shopify_customer_gid
           FROM pos_customers pc
           LEFT JOIN loyalty_balance lb ON lb.customer_id = pc.id
           ${where}
          ORDER BY COALESCE(lb.balance, 0) DESC, pc.last_name NULLS LAST, pc.first_name
          LIMIT $${idx0 + 1}::int OFFSET $${idx0 + 2}::int`,
        args,
      );
      const c = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pos_customers pc ${where}`,
        q ? [args[0]] : [],
      );
      return { rows: r.rows, total: Number(c.rows[0]?.n ?? 0) };
    },
    { rows: [], total: 0 },
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showFrom = total === 0 ? 0 : offset + 1;
  const showTo = Math.min(offset + rows.length, total);

  return (
    <main className="p-6 lg:p-8 max-w-6xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <UserSearch className="h-3.5 w-3.5" />
          Loyalty
        </div>
        <h1 className="text-2xl font-bold mt-1">Members</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every <code>pos_customers</code> row, sorted by balance.
        </p>
      </header>

      <form className="mb-4 flex gap-2 items-end">
        <label className="flex flex-col gap-1 flex-1 max-w-sm">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Search</span>
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Name, email, phone…"
            className="border border-border bg-card px-3 py-2"
          />
        </label>
        <button type="submit" className="border border-border bg-card hover:bg-muted px-4 py-2 text-sm font-semibold">
          Filter
        </button>
      </form>

      <div className="border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase tracking-wider font-bold">
            <tr>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Phone</th>
              <th className="text-right px-3 py-2">Balance</th>
              <th className="text-left px-3 py-2">Last activity</th>
              <th className="text-left px-3 py-2">Shopify</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No customers match.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-semibold">
                    {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-3 py-2">{r.email ?? "—"}</td>
                  <td className="px-3 py-2">{r.mobile_phone ?? r.phone ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold">
                    {Number(r.balance).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.last_event_at ? new Date(r.last_event_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.shopify_customer_gid ? (
                      <span className="text-emerald-600 text-xs">linked</span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      className="text-xs underline"
                      href={`/loyalty/customers/${r.id}`}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="px-3 py-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span>Showing {showFrom}–{showTo} of {total.toLocaleString()}</span>
          <div className="flex gap-2">
            <Link
              href={`?q=${encodeURIComponent(q)}&page=${Math.max(1, page - 1)}`}
              className={`px-2 py-1 border border-border ${page === 1 ? "opacity-40 pointer-events-none" : ""}`}
            >Prev</Link>
            <span className="px-2 py-1">Page {page} / {totalPages}</span>
            <Link
              href={`?q=${encodeURIComponent(q)}&page=${Math.min(totalPages, page + 1)}`}
              className={`px-2 py-1 border border-border ${page === totalPages ? "opacity-40 pointer-events-none" : ""}`}
            >Next</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
