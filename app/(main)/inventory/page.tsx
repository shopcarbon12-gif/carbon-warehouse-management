import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listInventory } from "@/lib/queries/inventory";

export const dynamic = "force-dynamic";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; zone?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  const sp = await searchParams;

  const rows = await withDb(
    (sql) =>
      listInventory(sql, session.lid, {
        q: sp.q,
        zone: sp.zone,
        limit: 80,
        offset: 0,
      }),
    [],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Inventory</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Filter with query params{" "}
        <code className="text-[var(--accent)]">?q=</code> and{" "}
        <code className="text-[var(--accent)]">?zone=rfid|bin</code>.
      </p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3 font-mono text-sm"
        method="get"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Search</span>
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="SKU, asset, name"
            className="rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Zone</span>
          <select
            name="zone"
            defaultValue={sp.zone ?? ""}
            className="rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)]"
          >
            <option value="">All</option>
            <option value="rfid">rfid</option>
            <option value="bin">bin</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--background)]"
        >
          Apply
        </button>
        <Link
          href="/inventory"
          className="rounded-md border border-[var(--surface-border)] px-4 py-2 text-[var(--foreground)]"
        >
          Clear
        </Link>
        <Link
          href="/alerts"
          className="ml-auto text-sm text-[var(--accent)] hover:underline"
        >
          View exceptions
        </Link>
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--surface-border)]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase text-[var(--muted)]">
              <th className="px-4 py-3">Asset</th>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Zone</th>
              <th className="px-4 py-3 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center font-mono text-[var(--muted)]">
                  No rows — run{" "}
                  <code className="text-[var(--accent)]">npm run db:seed</code>.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/40"
                >
                  <td className="px-4 py-2 font-mono text-xs text-[var(--accent)]">
                    {r.asset_id}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{r.sku}</td>
                  <td className="px-4 py-2">{r.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.zone}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.qty}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
