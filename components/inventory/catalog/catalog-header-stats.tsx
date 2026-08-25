"use client";

import useSWR from "swr";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.statusText);
  return res.json() as Promise<{ live_epc_count: number }>;
};

export function CatalogHeaderStats() {
  const { data } = useSWR<{ live_epc_count: number }>(
    "/api/inventory/catalog/stats",
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );
  const value = data?.live_epc_count;
  return (
    <div className="shrink-0 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-4 py-2 shadow-sm">
      <div className="font-mono text-[0.55rem] max-md:text-xs uppercase tracking-wide text-[var(--wms-muted)]">
        Live EPCs in catalog
      </div>
      <div className="mt-0.5 font-mono text-2xl tabular-nums text-emerald-300">
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
    </div>
  );
}
