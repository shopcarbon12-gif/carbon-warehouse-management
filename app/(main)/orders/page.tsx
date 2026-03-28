import { withDb } from "@/lib/db";
import { listOrders } from "@/lib/queries/orders";
import { WAREHOUSE } from "@/lib/zones";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const orders = await withDb((p) => listOrders(p), []);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Orders & Fulfillment</h1>
      <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--muted)]">
        {WAREHOUSE.name} — pull from Shopify and Lightspeed; pick by zone, pack, ship.
      </p>

      <div className="mt-8 overflow-x-auto rounded-lg border border-[var(--surface-border)]">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-4 py-3">Ref</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Lines</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center font-mono text-[var(--muted)]">
                  No orders — connect database or sync from Shopify / Lightspeed.
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/50"
                >
                  <td className="px-4 py-2.5 font-mono text-[var(--accent)]">
                    {o.external_ref ?? `#${o.id}`}
                  </td>
                  <td className="px-4 py-2.5 capitalize text-[var(--foreground)]">{o.source}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--foreground)]">
                    {o.status.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{o.line_count}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--muted)]">
                    {o.created_at}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
