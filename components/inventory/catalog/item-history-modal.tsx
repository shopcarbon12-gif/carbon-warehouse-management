"use client";

import { useEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import { History, RefreshCw, X } from "lucide-react";
import {
  cellTruncate,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type HistoryRow = {
  id: string;
  source: string;
  previous_qty: number | null;
  new_qty: number;
  delta_qty: number | null;
  changed_by_user_id: string | null;
  changed_by_user_name: string | null;
  changed_at: string;
  transfer_slip_number: string | null;
  transfer_from_code: string | null;
  transfer_to_code: string | null;
  notes: string | null;
  reference_id: string | null;
};

type HistoryResponse = {
  sku: {
    custom_sku_id: string;
    sku: string;
    color: string | null;
    size: string | null;
    matrix_upc: string | null;
    matrix_name: string;
    is_manual_only: boolean;
    current_qty: number;
  };
  rows: HistoryRow[];
  count: number;
};

const fetcher = async (url: string): Promise<HistoryResponse> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return (await r.json()) as HistoryResponse;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sourceLabel(s: string): string {
  switch (s) {
    case "lightspeed_sync":  return "Lightspeed sync";
    case "cycle_count":      return "Cycle count";
    case "manual_override":  return "Manual override";
    case "pos_sold":         return "POS — sold";
    case "pos_damaged":      return "POS — damaged";
    case "pos_exchange":     return "POS — exchange";
    case "pos_return":       return "POS — return";
    case "transfer_out":     return "Transfer out";
    case "transfer_in":      return "Transfer in";
    default:                 return s;
  }
}

function sourceBadgeClass(s: string): string {
  if (s === "lightspeed_sync") return "border-teal-400/40 bg-teal-400/10 text-teal-300";
  if (s === "cycle_count")     return "border-purple-400/40 bg-purple-400/10 text-purple-300";
  if (s === "manual_override") return "border-amber-400/40 bg-amber-400/10 text-amber-300";
  if (s.startsWith("pos_"))    return "border-blue-400/40 bg-blue-400/10 text-blue-300";
  if (s.startsWith("transfer_")) return "border-indigo-400/40 bg-indigo-400/10 text-indigo-300";
  return "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]";
}

const COLUMNS = [
  { label: "When" },
  { label: "Source" },
  { label: "From → To" },
  { label: "Δ" },
  { label: "User" },
  { label: "Notes" },
];

/**
 * Read-only Item History for a manual (non-RFID) SKU. Click on the catalog
 * "MANUAL" badge opens this. Qty changes happen only via cycle count /
 * Lightspeed sync / transfers / POS — no direct adjust action here.
 */
export function ItemHistoryModal({
  customSkuId,
  onClose,
}: {
  customSkuId: string;
  onClose: () => void;
  /** Kept for prop compatibility with existing callers; unused now that
   *  the Adjust button is gone. */
  onMutated?: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<HistoryResponse>(
    `/api/inventory/catalog/manual-items/${customSkuId}/history`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, COLUMNS.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sku = data?.sku;
  const subtitle = sku
    ? [sku.sku, sku.color?.trim(), sku.size?.trim()].filter(Boolean).join(" · ")
    : "";

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <History className="h-5 w-5" style={{ color: "oklch(82.8% 0.111 230.318)" }} />
              <div>
                <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
                  Item History
                </h2>
                {sku ? (
                  <p className="mt-1 text-sm text-white">
                    <span className="font-semibold">{sku.matrix_name}</span>
                    {subtitle ? <> · {subtitle}</> : null}
                    {sku.matrix_upc ? <> · UPC {sku.matrix_upc}</> : null}
                    <> · CURRENT QTY <span className="ml-1 font-semibold tabular-nums">{sku.current_qty}</span></>
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-white">Loading…</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-1.5 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-end border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-5 py-3">
            <button
              type="button"
              onClick={() => void mutate()}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>

          <div className="flex-1 overflow-auto">
            {error ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-red-400">
                Failed to load item history.
              </div>
            ) : (
              /* Table renders even when empty so headers are always visible —
                 the empty state lives inside <tbody>. */
              <table
                ref={tableRef}
                className="w-full min-w-[800px] border-collapse font-mono text-xs"
                style={{ tableLayout: pickTableLayout(colWidths) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                  <tr>
                    {COLUMNS.map((c, i) => {
                      const w = colWidths[i];
                      return (
                        <th
                          key={c.label}
                          style={w !== null ? { width: w, minWidth: w } : undefined}
                          className="relative overflow-hidden px-3 py-2 text-left"
                        >
                          <span>{c.label}</span>
                          <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={COLUMNS.length} className="px-5 py-8 text-center text-[var(--wms-muted)]">
                        Loading…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={COLUMNS.length} className="px-5 py-12 text-center text-[var(--wms-muted)]">
                        No history yet — qty changes will appear here once syncs, counts, or POS events fire.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => {
                      const transferLabel =
                        r.transfer_slip_number || r.transfer_from_code || r.transfer_to_code
                          ? `${r.transfer_slip_number ? `Slip #${r.transfer_slip_number} ` : ""}${
                              r.transfer_from_code ?? "?"
                            } → ${r.transfer_to_code ?? "?"}`
                          : null;
                      return (
                        <tr
                          key={r.id}
                          className="border-b border-[var(--wms-border)]/40 hover:bg-[var(--wms-surface-elevated)]/40"
                        >
                          <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>
                            {formatDate(r.changed_at)}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide ${sourceBadgeClass(r.source)}`}>
                              {sourceLabel(r.source)}
                            </span>
                          </td>
                          <td className={`${cellTruncate} px-3 py-2 tabular-nums text-[var(--wms-fg)]`}>
                            <span className="text-[var(--wms-muted)]">{r.previous_qty ?? "—"}</span>
                            <span className="mx-1 text-[var(--wms-muted)]">→</span>
                            <span className="font-semibold">{r.new_qty}</span>
                          </td>
                          <td className={`${cellTruncate} px-3 py-2 tabular-nums`}>
                            {r.delta_qty == null ? (
                              <span className="text-[var(--wms-muted)]">—</span>
                            ) : r.delta_qty === 0 ? (
                              <span className="text-[var(--wms-muted)]">0</span>
                            ) : r.delta_qty > 0 ? (
                              <span className="text-green-300">+{r.delta_qty}</span>
                            ) : (
                              <span className="text-red-300">{r.delta_qty}</span>
                            )}
                          </td>
                          <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>
                            {r.changed_by_user_name ?? "—"}
                          </td>
                          <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.notes ?? transferLabel ?? ""}>
                            {transferLabel ?? r.notes ?? "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
