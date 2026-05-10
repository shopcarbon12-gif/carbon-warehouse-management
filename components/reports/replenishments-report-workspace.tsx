"use client";

import useSWR from "swr";
import type { ReplenishmentLogRow } from "@/lib/queries/inventory-reports";
import { downloadCsv, rowsToCsv } from "@/lib/csv-export";
import { ReportToolbar } from "@/components/reports/report-toolbar";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";
import { useMemo, useRef, useState } from "react";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<ReplenishmentLogRow[]>;
};

export function ReplenishmentsReportWorkspace() {
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
    `/api/reports/replenishment-logs?${query}`,
    fetcher,
    { revalidateOnFocus: true },
  );

  const exportCsv = () => {
    if (!data?.length) return;
    const headers = ["id", "created_at", "sku", "qty", "from_bin", "to_bin", "status"];
    const rows = data.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      sku: r.sku,
      qty: r.qty,
      from_bin: r.from_bin,
      to_bin: r.to_bin,
      status: r.status,
    }));
    downloadCsv(`replenishments-${new Date().toISOString().slice(0, 10)}`, rowsToCsv(headers, rows));
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
      <ReplenishmentsTable data={data} isLoading={isLoading} />
    </div>
  );
}

function ReplenishmentsTable({
  data,
  isLoading,
}: {
  data: ReplenishmentLogRow[] | undefined;
  isLoading: boolean;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 6);
  const cols: { label: string; align?: "right" }[] = [
    { label: "When" },
    { label: "SKU" },
    { label: "Qty", align: "right" },
    { label: "From bin" },
    { label: "To bin" },
    { label: "Status" },
  ];
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[720px] border-collapse text-left text-sm"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
          <tr className="border-b border-[var(--wms-border)]">
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-3 ${c.align === "right" ? "text-right" : ""}`}
                >
                  <span>{c.label}</span>
                  <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80">
          {isLoading && !data ? (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                Loading…
              </td>
            </tr>
          ) : !data?.length ? (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                No replenishment resolutions logged yet.
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={row.id} className="text-[var(--wms-fg)]">
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]`}>
                  {new Date(row.created_at).toLocaleString()}
                </td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs`} title={row.sku}>{row.sku}</td>
                <td className="overflow-hidden px-3 py-2.5 text-right font-mono text-xs tabular-nums">{row.qty}</td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs`} title={row.from_bin}>{row.from_bin}</td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs`} title={row.to_bin}>{row.to_bin}</td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs`} title={row.status}>{row.status}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
