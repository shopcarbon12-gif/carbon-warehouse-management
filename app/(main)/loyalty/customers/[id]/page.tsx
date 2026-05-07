import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withDb } from "@/lib/db";
import { loyaltyPost } from "@/lib/loyalty-client";
import { getSession } from "@/lib/get-session";
import { UserSearch } from "lucide-react";

/**
 * Loyalty → Customer detail. Reads the ledger directly from Postgres for
 * speed, but the manual-adjust action POSTs to loyalty.shopcarbon.com so
 * the loyalty service's idempotency table is the system of record.
 */
export default async function CustomerDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const customerId = Number(id);
  if (!Number.isFinite(customerId)) notFound();

  const session = await getSession();
  const userId = session?.sub ?? null;

  const data = await withDb(
    async (pool) => {
      const c = await pool.query<{
        id: number;
        first_name: string;
        last_name: string | null;
        email: string | null;
        mobile_phone: string | null;
        phone: string | null;
        birthday: string | null;
        shopify_customer_gid: string | null;
        shopify_linked_at: string | null;
      }>(
        `SELECT id, first_name, last_name, email, mobile_phone, phone,
                birthday::text, shopify_customer_gid, shopify_linked_at::text
           FROM pos_customers WHERE id = $1`,
        [customerId],
      );
      if (c.rowCount === 0) return null;
      const balance = await pool.query<{ b: string }>(
        `SELECT COALESCE(SUM(delta_points), 0)::text AS b
           FROM loyalty_ledger WHERE customer_id = $1`,
        [customerId],
      );
      const ledger = await pool.query<{
        id: string;
        delta_points: number;
        reason: string;
        source: string;
        source_ref: string | null;
        amount_basis: string | null;
        created_at: string;
      }>(
        `SELECT id::text, delta_points, reason, source, source_ref,
                amount_basis::text, created_at
           FROM loyalty_ledger
          WHERE customer_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [customerId],
      );
      return {
        customer: c.rows[0],
        balance: Number(balance.rows[0]?.b ?? 0),
        ledger: ledger.rows,
      };
    },
    null,
  );

  if (!data) notFound();
  const c = data.customer;

  async function adjust(formData: FormData) {
    "use server";
    const session = await getSession();
    if (!session?.sub) {
      return;
    }
    const delta = Number(formData.get("delta_points") ?? 0);
    const reason = String(formData.get("reason_text") ?? "").trim();
    if (!Number.isFinite(delta) || delta === 0 || !reason) return;
    await loyaltyPost("/api/admin/adjust", {
      customer_id: customerId,
      delta_points: delta,
      reason_text: reason,
      acted_by_user_id: session.sub,
    });
    redirect(`/loyalty/customers/${customerId}`);
  }

  return (
    <main className="p-6 lg:p-8 max-w-5xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <UserSearch className="h-3.5 w-3.5" />
          Loyalty · <Link className="underline" href="/loyalty/customers">Members</Link>
        </div>
        <h1 className="text-2xl font-bold mt-1">
          {[c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {c.email ?? ""}
          {c.mobile_phone || c.phone ? ` · ${c.mobile_phone ?? c.phone}` : ""}
          {c.birthday ? ` · 🎂 ${c.birthday}` : ""}
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
        <section>
          <div className="border border-border bg-card p-5 mb-4">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Loyalty balance</div>
                <div className="text-4xl font-bold tabular-nums mt-1">{data.balance.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-1">points · ≈ ${(data.balance / 10).toFixed(2)} to spend</div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>Shopify</div>
                {c.shopify_customer_gid ? (
                  <span className="text-emerald-600">linked</span>
                ) : (
                  <span>not linked</span>
                )}
                {c.shopify_linked_at ? (
                  <div className="mt-1">{new Date(c.shopify_linked_at).toLocaleDateString()}</div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="border border-border bg-card overflow-x-auto">
            <h2 className="text-base font-bold p-4 border-b border-border">
              Ledger · last 100
            </h2>
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs uppercase tracking-wider font-bold">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-right px-3 py-2">Δ Pts</th>
                  <th className="text-left px-3 py-2">Reason</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Ref</th>
                  <th className="text-right px-3 py-2">Basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.ledger.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No activity yet.</td></tr>
                ) : (
                  data.ledger.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td>
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
        </section>

        <aside>
          <div className="border border-border bg-card p-5">
            <h2 className="text-base font-bold mb-2">Manual adjustment</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Direct ledger write. Posts through the loyalty service so it&rsquo;s
              idempotent + auditable. Manager-only — every adjustment carries
              your user id.
            </p>
            {!userId ? (
              <p className="text-sm text-rose-700">Not signed in.</p>
            ) : (
              <form action={adjust} className="space-y-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                    Δ Points (negative = remove)
                  </span>
                  <input
                    type="number"
                    name="delta_points"
                    required
                    className="border border-border bg-background px-3 py-2"
                    placeholder="e.g. 100 or -50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                    Reason
                  </span>
                  <textarea
                    name="reason_text"
                    required
                    rows={3}
                    className="border border-border bg-background px-3 py-2"
                    placeholder="Customer service goodwill / migration tweak / …"
                  />
                </label>
                <button
                  type="submit"
                  className="w-full border border-border bg-foreground text-background px-4 py-2 text-sm font-bold hover:opacity-90"
                >
                  Adjust
                </button>
              </form>
            )}
          </div>
          <div className="border border-border bg-card p-5 mt-4">
            <h2 className="text-base font-bold mb-2">Quick links</h2>
            <ul className="text-sm space-y-1">
              <li>
                <a className="underline" href={`https://loyalty.shopcarbon.com/admin/ledger?customer_id=${customerId}`} target="_blank" rel="noreferrer">
                  Loyalty admin ledger ↗
                </a>
              </li>
              {c.shopify_customer_gid ? (
                <li>
                  <a className="underline" href={`https://admin.shopify.com/store/30e7d3/customers/${c.shopify_customer_gid.split("/").pop()}`} target="_blank" rel="noreferrer">
                    Shopify customer ↗
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
