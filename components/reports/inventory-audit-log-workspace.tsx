"use client";

import useSWR from "swr";
import type { InventoryAuditLogRow } from "@/lib/queries/inventory-reports";
import { downloadCsv, rowsToCsv } from "@/lib/csv-export";
import { ReportToolbar } from "@/components/reports/report-toolbar";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";
import { useMemo, useState } from "react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<InventoryAuditLogRow[]>;
};

type InventoryAuditLogWorkspaceProps = {
  logTypes: string[];
  exportFilePrefix: string;
  emptyLabel: string;
};

export function InventoryAuditLogWorkspace({
  logTypes,
  exportFilePrefix,
  emptyLabel,
}: InventoryAuditLogWorkspaceProps) {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const debounced = useDebouncedValue(search, 400);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set("logType", logTypes.join(","));
    if (debounced.trim()) p.set("search", debounced.trim());
    if (dateFrom.trim()) p.set("dateFrom", dateFrom.trim());
    if (dateTo.trim()) p.set("dateTo", dateTo.trim());
    return p.toString();
  }, [logTypes, debounced, dateFrom, dateTo]);

  const { data, error, isLoading } = useSWR(
    `/api/reports/inventory-audit-logs?${query}`,
    fetcher,
    { revalidateOnFocus: true },
  );

  const exportCsv = () => {
    if (!data?.length) return;
    const headers = [
      "id",
      "created_at",
      "log_type",
      "entity_type",
      "entity_reference",
      "old_value",
      "new_value",
      "reason",
      "user_id",
    ];
    const rows = data.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      log_type: r.log_type,
      entity_type: r.entity_type,
      entity_reference: r.entity_reference,
      old_value: r.old_value ?? "",
      new_value: r.new_value ?? "",
      reason: r.reason ?? "",
      user_id: r.user_id ?? "",
    }));
    downloadCsv(`${exportFilePrefix}-${new Date().toISOString().slice(0, 10)}`, rowsToCsv(headers, rows));
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
        <table className="w-full min-w-[880px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)] dark:border-[var(--wms-border)]">
              <th className="px-3 py-3">When</th>
              <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3">Entity</th>
              <th className="px-3 py-3">Reference</th>
              <th className="px-3 py-3">Old → New</th>
              <th className="px-3 py-3">Reason</th>
              <th className="px-3 py-3 text-right">User</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 dark:divide-[var(--wms-border)]/80">
            {isLoading && !data ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : !data?.length ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              data.map((row) => (
                <tr key={row.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.log_type}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.entity_type}</td>
                  <td className="max-w-[200px] truncate px-3 py-2.5 font-mono text-xs" title={row.entity_reference}>
                    {row.entity_reference}
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    <span className="text-red-400/90">{row.old_value ?? "—"}</span>
                    <span className="mx-1 text-[var(--wms-fg)]">→</span>
                    <span className="text-emerald-400/90">{row.new_value ?? "—"}</span>
                  </td>
                  <td className="max-w-[200px] truncate px-3 py-2.5 text-xs" title={row.reason ?? ""}>
                    {row.reason ?? "—"}
                  </td>
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
