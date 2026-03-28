import { withDb } from "@/lib/db";
import { listInventory } from "@/lib/queries/inventory";
import { WAREHOUSE } from "@/lib/zones";

export default async function InventoryPage() {
  const rows = await withDb((p) => listInventory(p), []);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Inventory & Stock</h1>
      <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--muted)]">
        {WAREHOUSE.name} — quantities by SKU and zone. Feed from Shopify / Lightspeed / Senitron sync
        jobs.
      </p>

      <div className="mt-8 overflow-x-auto rounded-lg border border-[var(--surface-border)]">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Zone</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3">Shopify</th>
              <th className="px-4 py-3">Lightspeed</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center font-mono text-[var(--muted)]">
                  No rows — set DATABASE_URL and run{" "}
                  <code className="text-[var(--accent)]">docker compose up -d</code> with{" "}
                  <code className="text-[var(--accent)]">scripts/init-db.sql</code>.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr
                  key={`${r.sku}-${r.zone_code}-${i}`}
                  className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/50"
                >
                  <td className="px-4 py-2.5 font-mono text-[var(--accent)]">{r.sku}</td>
                  <td className="px-4 py-2.5 text-[var(--foreground)]">{r.title ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{r.zone_code}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                    {r.quantity}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--muted)]">
                    {r.shopify_variant_id ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--muted)]">
                    {r.lightspeed_item_id ?? "—"}
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
