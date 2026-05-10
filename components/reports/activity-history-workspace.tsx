"use client";

import { useRef } from "react";
import useSWR from "swr";
import type { AuditLogListRow } from "@/lib/queries/dashboard-command";
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
  return res.json() as Promise<AuditLogListRow[]>;
};

function formatLine(row: AuditLogListRow): string {
  const bits: string[] = [row.action, row.entity].filter(Boolean);
  if (row.metadata && typeof row.metadata === "object" && row.metadata !== null) {
    const m = row.metadata as Record<string, unknown>;
    const summary = m.summary ?? m.detail ?? m.label;
    if (typeof summary === "string" && summary.length < 120) {
      bits.push(`— ${summary}`);
    }
  }
  return bits.join(" · ");
}

export function ActivityHistoryWorkspace() {
  const { data, error, isLoading } = useSWR("/api/reports/audit?limit=200", fetcher, {
    revalidateOnFocus: true,
  });
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 2);

  if (error) {
    return <p className="font-mono text-xs text-red-500/90">{String(error.message)}</p>;
  }

  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[720px] border-collapse text-left text-sm"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
          <tr className="border-b border-[var(--wms-border)]">
            {["When", "Event"].map((label, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={label}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className="relative overflow-hidden px-3 py-3"
                >
                  <span>{label}</span>
                  <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80">
          {isLoading && !data ? (
            <tr>
              <td colSpan={2} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                Loading…
              </td>
            </tr>
          ) : !data?.length ? (
            <tr>
              <td colSpan={2} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                No audit rows.
              </td>
            </tr>
          ) : (
            data.map((row) => {
              const line = formatLine(row);
              return (
                <tr key={row.id}>
                  <td className={`${cellTruncate} px-3 py-2.5 font-mono text-[0.65rem] tabular-nums text-[var(--wms-muted)]`}>
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs leading-snug text-[var(--wms-fg)]`} title={line}>
                    {line}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
