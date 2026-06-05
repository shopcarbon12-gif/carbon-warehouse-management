import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { loyaltyPost } from "@/lib/loyalty-client";
import { getSession } from "@/lib/get-session";
import { shortName } from "@/lib/format-name";
import { AlertTriangle, UserSearch } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Loyalty → Customer detail. Mirrors rewards.shopcarbon.com/admin/customers/[id]:
 *   - ＋ Reward points  (positive integer, optional 60-char note)
 *   - ⇄ Adjust points  (signed integer, optional 60-char note)
 * Both write reason='manual', source='admin' via the loyalty service's
 * /api/admin/adjust endpoint (idempotent + auditable). The Source column in
 * the ledger resolves source='pos' rows to "<code> · <name>" via
 * pos_sales → pos_locations → locations (matches Loyalty's JOIN).
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

  type Customer = {
    id: number;
    first_name: string;
    last_name: string | null;
    email: string | null;
    email_2: string | null;
    phone: string | null;
    phone_2: string | null;
    birthday: string | null;
    shopify_customer_gid: string | null;
    shopify_linked_at: string | null;
    created_at: string;
    created_via: string | null;
    created_at_geo: string | null;
    pos_location_name: string | null;
    created_by_email: string | null;
    created_by_first: string | null;
    created_by_last: string | null;
  };

  type LedgerRow = {
    id: string;
    delta_points: number;
    reason: string;
    source: string;
    source_ref: string | null;
    amount_basis: string | null;
    created_at: string;
    pos_location_code: string | null;
    pos_location_name: string | null;
  };

  let customer: Customer | null = null;
  let balance = 0;
  let ledger: LedgerRow[] = [];
  let dbError: string | null = null;
  let pgCode: string | null = null;

  const pool = getPool();
  if (!pool) {
    dbError = "Database unavailable (DATABASE_URL not set on this instance).";
  } else {
    try {
      const c = await pool.query<Customer>(
        `SELECT pc.id, pc.first_name, pc.last_name, pc.email, pc.email_2, pc.phone, pc.phone_2,
                pc.birthday::text, pc.shopify_customer_gid, pc.shopify_linked_at::text,
                pc.created_at::text,
                pc.created_via, pc.created_at_geo,
                -- pos_locations has no name; resolve through WMS locations
                l.name AS pos_location_name,
                u.email AS created_by_email,
                u.first_name AS created_by_first,
                u.last_name AS created_by_last
           FROM pos_customers pc
           LEFT JOIN pos_locations pl ON pl.id = pc.pos_location_id
           LEFT JOIN locations     l  ON l.id  = pl.wms_location_id
           LEFT JOIN users         u  ON u.id  = pc.created_by_user_id
          WHERE pc.id = $1`,
        [customerId],
      );
      if (c.rowCount === 0) notFound();
      customer = c.rows[0]!;

      const balR = await pool.query<{ b: string }>(
        `SELECT COALESCE(SUM(delta_points), 0)::text AS b
           FROM loyalty_ledger WHERE customer_id = $1`,
        [customerId],
      );
      balance = Number(balR.rows[0]?.b ?? 0);

      // Mirror Loyalty's JOIN: resolve source='pos' rows to "<code> · <name>"
      // via pos_sales → pos_locations → locations (WMS-side). source_ref is
      // either 'pos:sale:<id>' or 'pos:redeem:<id>'; match both.
      const lR = await pool.query<LedgerRow>(
        `SELECT ll.id::text, ll.delta_points, ll.reason, ll.source, ll.source_ref,
                ll.amount_basis::text, ll.created_at,
                l.code AS pos_location_code,
                l.name AS pos_location_name
           FROM loyalty_ledger ll
           LEFT JOIN pos_sales     ps
             ON ll.source = 'pos'
            AND ll.source_ref IN ('pos:sale:' || ps.id::text,
                                  'pos:redeem:' || ps.id::text)
           LEFT JOIN pos_locations pl ON pl.id = ps.pos_location_id
           LEFT JOIN locations     l  ON l.id  = pl.wms_location_id
          WHERE ll.customer_id = $1
          ORDER BY ll.created_at DESC
          LIMIT 100`,
        [customerId],
      );
      ledger = lR.rows;
    } catch (e) {
      console.error("[loyalty/customers/detail] db query failed:", e);
      dbError = e instanceof Error ? e.message : "Unknown database error";
      pgCode =
        e && typeof e === "object" && "code" in e
          ? String((e as { code?: unknown }).code ?? "")
          : null;
    }
  }

  // If the DB had a hard failure (not "row missing"), show a banner instead
  // of forcing notFound(). Better than the click-goes-nowhere bug.
  if (!customer && !dbError) notFound();

  function provenanceLabel(via: string | null | undefined): string {
    switch (via) {
      case "pos":        return "Store register";
      case "shopify":    return "Online (Shopify)";
      case "wms_manual": return "WMS · Manual add";
      case "wms_csv":    return "WMS · Bulk CSV";
      case "admin":      return "Admin";
      case "legacy":     return "Legacy (pre-tracking)";
      default:           return "—";
    }
  }

  // Server actions ----------------------------------------------------------
  // Both POST through the loyalty service's /api/admin/adjust which stamps
  // reason='manual' server-side. After write, revalidate AND redirect so the
  // ledger row appears on next render.
  async function rewardAction(formData: FormData) {
    "use server";
    const s = await getSession();
    if (!s?.sub) return;
    const pts = Number(formData.get("points") ?? 0);
    const note = String(formData.get("note") ?? "").trim().slice(0, 60);
    if (!Number.isFinite(pts) || pts <= 0) return;
    await loyaltyPost("/api/admin/adjust", {
      customer_id: customerId,
      delta_points: Math.floor(pts),
      reason_text: note || "manual",
      acted_by_user_id: s.sub,
    });
    revalidatePath(`/rewards/customers/${customerId}`);
    redirect(`/rewards/customers/${customerId}`);
  }

  async function deductAction(formData: FormData) {
    "use server";
    const s = await getSession();
    if (!s?.sub) return;
    const pts = Number(formData.get("points") ?? 0);
    const note = String(formData.get("note") ?? "").trim().slice(0, 60);
    if (!Number.isFinite(pts) || pts <= 0) return;
    await loyaltyPost("/api/admin/adjust", {
      customer_id: customerId,
      delta_points: -Math.floor(pts),
      reason_text: note || "manual",
      acted_by_user_id: s.sub,
    });
    revalidatePath(`/rewards/customers/${customerId}`);
    redirect(`/rewards/customers/${customerId}`);
  }

  const c = customer;

  return (
    <main className="p-6 lg:p-8 max-w-5xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <UserSearch className="h-3.5 w-3.5" />
          Rewards · <Link className="underline" href="/rewards/customers">Customers</Link>
        </div>
        <h1 className="text-2xl font-bold mt-1">
          {c ? [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)" : "—"}
        </h1>
        {c ? (
          <>
            <p className="text-sm text-muted-foreground mt-1">
              {c.email ?? ""}
              {c.phone || c.phone_2 ? ` · ${c.phone ?? c.phone_2}` : ""}
              {c.birthday ? ` · 🎂 ${c.birthday}` : ""}
            </p>
            <div className="mt-3 inline-flex flex-wrap items-center gap-3 px-3 py-2 border border-border bg-muted/40 text-xs text-muted-foreground">
              <span>
                <b className="text-foreground">Source:</b> {provenanceLabel(c.created_via)}
              </span>
              <span aria-hidden>·</span>
              <span>
                <b className="text-foreground">Where added:</b>{" "}
                {c.pos_location_name ?? c.created_at_geo ?? "—"}
              </span>
              <span aria-hidden>·</span>
              <span>
                <b className="text-foreground">By:</b>{" "}
                {shortName(c.created_by_first, c.created_by_last, c.created_by_email)}
              </span>
              <span aria-hidden>·</span>
              <span>
                <b className="text-foreground">When:</b> {new Date(c.created_at).toLocaleString()}
              </span>
            </div>
          </>
        ) : null}
      </header>

      {dbError ? (
        <div className="mb-4 flex items-start gap-2 border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-bold">Couldn&rsquo;t load this customer.</p>
            <p className="mt-1 font-mono text-xs">
              {dbError}
              {pgCode ? ` (pg ${pgCode})` : ""}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
        <section>
          <div className="border border-border bg-card p-5 mb-4">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Rewards balance</div>
                <div className="text-4xl font-bold tabular-nums mt-1">{balance.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-1">points · ≈ ${(balance / 10).toFixed(2)} to spend</div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>Shopify</div>
                {c?.shopify_customer_gid ? (
                  <span className="text-emerald-600">linked</span>
                ) : (
                  <span>not linked</span>
                )}
                {c?.shopify_linked_at ? (
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
                {ledger.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No activity yet.</td></tr>
                ) : (
                  ledger.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${row.delta_points > 0 ? "text-emerald-600" : "text-rose-700"}`}>
                        {row.delta_points > 0 ? "+" : ""}{row.delta_points}
                      </td>
                      <td className="px-3 py-2">{row.reason}</td>
                      <td className="px-3 py-2">
                        {row.source === "pos" && row.pos_location_code
                          ? `${row.pos_location_code} · ${row.pos_location_name ?? ""}`
                          : row.source}
                      </td>
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

        <aside className="space-y-4">
          <div className="border border-border bg-card p-5">
            <h2 className="text-base font-bold mb-2">＋ Rewards points</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Manager override · adds points to this customer. Posts through
              the loyalty service so it&rsquo;s idempotent + auditable.
            </p>
            {!userId ? (
              <p className="text-sm text-rose-700">Not signed in.</p>
            ) : (
              <form action={rewardAction} className="space-y-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Points</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    name="points"
                    required
                    className="border border-border bg-background px-3 py-2"
                    placeholder="100"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Note (optional)</span>
                  <input
                    type="text"
                    name="note"
                    maxLength={60}
                    className="border border-border bg-background px-3 py-2"
                    placeholder="Reason / reference"
                  />
                </label>
                <button
                  type="submit"
                  className="w-full border border-border bg-foreground text-background px-4 py-2 text-sm font-bold hover:opacity-90"
                >
                  Reward points
                </button>
              </form>
            )}
          </div>

          <div className="border border-border bg-card p-5">
            <h2 className="text-base font-bold mb-2">− Rewards points</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Manager override · deducts points from this customer.
            </p>
            {!userId ? (
              <p className="text-sm text-rose-700">Not signed in.</p>
            ) : (
              <form action={deductAction} className="space-y-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Points to deduct</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    name="points"
                    required
                    className="border border-border bg-background px-3 py-2"
                    placeholder="100"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Note (optional)</span>
                  <input
                    type="text"
                    name="note"
                    maxLength={60}
                    className="border border-border bg-background px-3 py-2"
                    placeholder="Reason / reference"
                  />
                </label>
                <button
                  type="submit"
                  className="w-full border border-border bg-card hover:bg-muted text-foreground px-4 py-2 text-sm font-bold"
                >
                  Deduct points
                </button>
              </form>
            )}
          </div>

          <div className="border border-border bg-card p-5">
            <h2 className="text-base font-bold mb-2">Quick links</h2>
            <ul className="text-sm space-y-1">
              <li>
                <a className="underline" href={`https://rewards.shopcarbon.com/admin/ledger?customer_id=${customerId}`} target="_blank" rel="noreferrer">
                  Rewards admin ledger ↗
                </a>
              </li>
              {c?.shopify_customer_gid ? (
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
