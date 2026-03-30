"use client";

import useSWR from "swr";
import type { ExternalSystemLogRow } from "@/lib/queries/inventory-reports";
import { downloadCsv, rowsToCsv } from "@/lib/csv-export";
import { ReportToolbar } from "@/components/reports/report-toolbar";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";
import { useMemo, useState } from "react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<ExternalSystemLogRow[]>;
};

export function ExternalSystemsReportWorkspace() {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 400);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (debounced.trim()) p.set("search", debounced.trim());
    return p.toString();
  }, [debounced]);

  const { data, error, isLoading } = useSWR(
    `/api/reports/external-system-logs?${query}`,
    fetcher,
    { revalidateOnFocus: true },
  );

  const exportCsv = () => {
    if (!data?.length) return;
    const headers = ["id", "created_at", "system_name", "direction", "status", "payload_summary"];
    const rows = data.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      system_name: r.system_name,
      direction: r.direction,
      status: r.status,
      payload_summary: r.payload_summary ?? "",
    }));
    downloadCsv(`external-systems-${new Date().toISOString().slice(0, 10)}`, rowsToCsv(headers, rows));
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
      />
      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] dark:border-[var(--wms-border)]">
        <table className="w-full min-w-[800px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)] dark:border-[var(--wms-border)]">
              <th className="px-3 py-3">When</th>
              <th className="px-3 py-3">System</th>
              <th className="px-3 py-3">Direction</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Payload summary</th>
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
                  No external system calls logged yet.
                </td>
              </tr>
            ) : (
              data.map((row) => (
                <tr key={row.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.system_name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.direction}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.status}</td>
                  <td className="max-w-md truncate px-3 py-2.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    {row.payload_summary ?? "—"}
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
