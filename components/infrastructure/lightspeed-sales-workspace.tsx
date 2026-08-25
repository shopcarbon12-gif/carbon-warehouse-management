"use client";

import { useCallback, useRef, useState } from "react";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type SaleRow = {
  saleID: string;
  timeStamp: string;
  calcTotal: string;
  completed: string;
  voided: string;
  referenceNumber: string;
  shopID: string;
  customerID: string;
};

type ApiOk = {
  ok: true;
  limit: number;
  offset: number;
  totalCount: number;
  sales: SaleRow[];
};

export function LightspeedSalesWorkspace() {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 7);

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const u = new URL("/api/lightspeed/sales", window.location.origin);
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("offset", String(nextOffset));
      const res = await fetch(u.toString());
      const j = (await res.json()) as ApiOk | { error?: string };
      if (!res.ok) {
        throw new Error((j as { error?: string }).error ?? res.statusText);
      }
      const ok = j as ApiOk;
      setRows(ok.sales);
      setTotalCount(ok.totalCount);
      setOffset(nextOffset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setRows([]);
      setTotalCount(null);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(0)}
          className="rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
        >
          {loading ? "Loading…" : "Load recent sales"}
        </button>
        <button
          type="button"
          disabled={loading || offset < limit}
          onClick={() => void load(Math.max(0, offset - limit))}
          className="rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-medium text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
        >
          Previous page
        </button>
        <button
          type="button"
          disabled={
            loading ||
            rows.length < limit ||
            (totalCount != null && offset + limit >= totalCount)
          }
          onClick={() => void load(offset + limit)}
          className="rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-medium text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
        >
          Next page
        </button>
        {totalCount != null ? (
          <span className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
            offset {offset} · reported total {totalCount}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="rounded border border-amber-700/40 bg-[color-mix(in_srgb,#b45309_16%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-medium text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
          {error}
        </p>
      ) : null}

      <DataTableContainer maxHeight="min(70vh, 640px)">
        <table
          ref={tableRef}
          className="w-full min-w-[720px] border-collapse text-left text-sm max-md:min-w-[560px]"
          style={{ tableLayout: pickTableLayout(colWidths) }}
        >
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-xs uppercase text-[var(--wms-muted)]">
            <tr className="border-b border-[var(--wms-border)]">
              {["Sale ID", "Time", "Total", "Done", "Void", "Reference", "Shop"].map(
                (label, i) => {
                  const w = colWidths[i];
                  // Done / Void are pruned at <md (td twins carry the same
                  // max-md:hidden so column alignment stays in lockstep).
                  const mobileHidden = label === "Done" || label === "Void";
                  return (
                    <th
                      key={label}
                      style={w !== null ? { width: w, minWidth: w } : undefined}
                      className={`relative overflow-hidden px-3 py-2${mobileHidden ? " max-md:hidden" : ""}`}
                    >
                      <span>{label}</span>
                      <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                    </th>
                  );
                },
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  No rows — load sales (R-Series API, admin only).
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.saleID || r.referenceNumber} className="border-b border-[var(--wms-border)]/60">
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-fg)]`} title={r.saleID}>{r.saleID || "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-muted)]`} title={r.timeStamp}>{r.timeStamp || "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-fg)]`} title={r.calcTotal}>{r.calcTotal || "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-muted)] max-md:hidden`} title={r.completed}>{r.completed || "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-muted)] max-md:hidden`} title={r.voided}>{r.voided || "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-muted)]`} title={r.referenceNumber}>{r.referenceNumber || "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs text-[var(--wms-muted)]`} title={r.shopID}>{r.shopID || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </DataTableContainer>
    </div>
  );
}
