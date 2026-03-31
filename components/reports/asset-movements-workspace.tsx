"use client";

import useSWR from "swr";
import type { AssetMovementRow } from "@/lib/queries/inventory-reports";
import { downloadCsv, rowsToCsv } from "@/lib/csv-export";
import { ReportToolbar } from "@/components/reports/report-toolbar";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";
import { useMemo, useState } from "react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<AssetMovementRow[]>;
};

export function AssetMovementsWorkspace() {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const debounced = useDebouncedValue(search, 400);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (debounced.trim()) p.set("search", debounced.trim());
    if (dateFrom.trim()) p.set("dateFrom", dateFrom.trim());
    if (dateTo.trim()) p.set("dateTo", dateTo.trim());
    return p.toString();
  }, [debounced, dateFrom, dateTo]);

  const { data, error, isLoading } = useSWR(
    `/api/reports/asset-movements?${query}`,
    fetcher,
    { revalidateOnFocus: true },
  );

  const exportCsv = () => {
    if (!data?.length) return;
    const headers = ["id", "created_at", "epc", "from_location", "to_location", "user_id"];
    const rows = data.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      epc: r.epc,
      from_location: r.from_location ?? "",
      to_location: r.to_location,
      user_id: r.user_id ?? "",
    }));
    downloadCsv(`asset-movements-${new Date().toISOString().slice(0, 10)}`, rowsToCsv(headers, rows));
  };

  if (error) {
    return <p className="font-mono text-xs text-red-500/90">{String(error.message)}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ReportToolbar
        search={search}
        onSearchChange={setSearch}
        onExportCsv={exportCsv}
        exportDisabled={!data?.length}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
      />
      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] dark:border-[var(--wms-border)]">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)] dark:border-[var(--wms-border)]">
              <th className="px-3 py-3">When</th>
              <th className="px-3 py-3">EPC</th>
              <th className="px-3 py-3">From</th>
              <th className="px-3 py-3">To</th>
              <th className="px-3 py-3 text-right">User</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 dark:divide-[var(--wms-border)]/80">
            {isLoading && !data ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : !data?.length ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  No asset movements recorded yet.
                </td>
              </tr>
            ) : (
              data.map((row) => (
                <tr key={row.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.epc}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[var(--wms-muted)]">
                    {row.from_location ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.to_location}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                    {row.user_id ?? "—"}
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
