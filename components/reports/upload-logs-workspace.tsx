"use client";

import { useRef } from "react";
import useSWR from "swr";
import type { DeviceUploadLogRow } from "@/lib/queries/device-upload-logs";
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
  return res.json() as Promise<DeviceUploadLogRow[]>;
};

export function UploadLogsWorkspace() {
  const { data, error, isLoading } = useSWR("/api/reports/upload-logs", fetcher, {
    revalidateOnFocus: true,
  });
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 4);

  if (error) {
    return <p className="font-mono text-xs text-red-500/90">{String(error.message)}</p>;
  }

  const cols: { label: string; align?: "right"; mobileCls?: string }[] = [
    { label: "Date" },
    { label: "Device" },
    { label: "Mode" },
    {
      label: "CSV",
      align: "right",
      mobileCls:
        "max-md:sticky max-md:right-0 max-md:z-[11] max-md:bg-[var(--wms-surface-elevated)] max-md:shadow-[inset_2px_0_0_var(--wms-border)]",
    },
  ];

  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[640px] max-md:min-w-[480px] border-collapse text-left text-sm"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] max-md:text-xs uppercase text-[var(--wms-muted)]">
          <tr className="border-b border-[var(--wms-border)]">
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-3 ${c.align === "right" ? "text-right" : ""} ${c.mobileCls ?? ""}`}
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
              <td colSpan={4} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                Loading…
              </td>
            </tr>
          ) : !data?.length ? (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                No uploads yet.
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={row.id} className="text-[var(--wms-fg)]">
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]`}>
                  {new Date(row.created_at).toLocaleString()}
                </td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs`} title={row.device_id}>{row.device_id}</td>
                <td className={`${cellTruncate} px-3 py-2.5`} title={row.workflow_mode}>{row.workflow_mode}</td>
                <td className="overflow-hidden px-3 py-2.5 text-right max-md:sticky max-md:right-0 max-md:z-[5] max-md:bg-[var(--wms-surface)] max-md:shadow-[inset_2px_0_0_var(--wms-border)]">
                  <a
                    href={`/api/reports/upload-logs/${row.id}`}
                    className="font-mono text-xs text-[var(--wms-accent)] hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
                    download
                  >
                    Download CSV
                  </a>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
