"use client";

import useSWR from "swr";

/**
 * Catalog Categories overview (/inventory/categories). Lists each catalog
 * category with its subcategories and counts of styles (matrices) and
 * variants (non-archived custom_skus). Read-only first cut — edit/merge can
 * be layered on later. Category/subcategory values themselves are edited per
 * item from the catalog item + matrix popups.
 */

type CategoryRow = {
  name: string;
  matrix_count: number;
  variant_count: number;
  subcategories: string[];
};

const fetcher = async (url: string): Promise<{ categories: CategoryRow[] }> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

export function CategoriesWorkspace() {
  const { data, error, isLoading } = useSWR("/api/inventory/categories", fetcher, {
    revalidateOnFocus: false,
  });
  const categories = data?.categories ?? [];

  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-[var(--wms-muted)]">
        Catalog categories aggregated from every item. Counts reflect styles
        (matrices) and live variants. Edit a category/subcategory on an item from
        the Catalog → item / Matrix popup.
      </p>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load categories"}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Subcategories</th>
              <th className="px-4 py-3 text-right">Styles</th>
              <th className="px-4 py-3 text-right">Variants</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80">
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : categories.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  No categories yet. Set a category on items from the Catalog.
                </td>
              </tr>
            ) : (
              categories.map((c) => (
                <tr key={c.name} className="text-[var(--wms-fg)]">
                  <td className="px-4 py-2.5 font-medium">{c.name}</td>
                  <td className="px-4 py-2.5">
                    {c.subcategories.length === 0 ? (
                      <span className="font-mono text-[0.65rem] text-[var(--wms-muted)]">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {c.subcategories.map((s) => (
                          <span
                            key={s}
                            className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-0.5 font-mono text-[0.6rem] text-[var(--wms-muted)]"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{c.matrix_count}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{c.variant_count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
