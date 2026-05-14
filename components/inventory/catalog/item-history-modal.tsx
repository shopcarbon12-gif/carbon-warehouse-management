"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { History, Pencil, RefreshCw, X } from "lucide-react";
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

export function ItemHistoryModal({
  customSkuId,
  onClose,
  onMutated,
}: {
  customSkuId: string;
  onClose: () => void;
  onMutated?: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<HistoryResponse>(
    `/api/inventory/catalog/manual-items/${customSkuId}/history`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 6);

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustValue, setAdjustValue] = useState("");
  const [adjustNotes, setAdjustNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submitAdjust = useCallback(async () => {
    setMsg(null);
    const newQty = Number.parseInt(adjustValue, 10);
    if (!Number.isFinite(newQty) || newQty < 0 || newQty > 999_999) {
      setMsg("Enter a quantity between 0 and 999,999.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/inventory/catalog/manual-items/${customSkuId}/override`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newQty,
            notes: adjustNotes.trim() || undefined,
          }),
        },
      );
      const j = (await res.json()) as { error?: string; previousQty?: number; newQty?: number };
      if (!res.ok) throw new Error(j.error ?? "Override failed");
      setMsg(`Quantity set to ${j.newQty} (was ${j.previousQty ?? 0}).`);
      setAdjustOpen(false);
      setAdjustValue("");
      setAdjustNotes("");
      await mutate();
      onMutated?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Override failed");
    } finally {
      setBusy(false);
    }
  }, [customSkuId, adjustValue, adjustNotes, mutate, onMutated]);

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
                  <p className="mt-0.5 text-xs text-[var(--wms-muted)]">
                    <span className="text-[var(--wms-fg)]">{sku.matrix_name}</span>
                    {subtitle ? <> · {subtitle}</> : null}
                    {sku.matrix_upc ? <> · UPC {sku.matrix_upc}</> : null}
                    <> · current qty <span className="font-semibold text-[var(--wms-fg)] tabular-nums">{sku.current_qty}</span></>
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-[var(--wms-muted)]">Loading…</p>
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

          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-5 py-3">
            <button
              type="button"
              onClick={() => {
                setAdjustOpen(true);
                setAdjustValue(sku ? String(sku.current_qty) : "");
              }}
              disabled={!sku || !sku.is_manual_only}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-xs uppercase tracking-wide hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                borderColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 45%, transparent)",
                backgroundColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 18%, var(--wms-surface-elevated))",
                color: "oklch(82.8% 0.111 230.318)",
              }}
              title="Set a new absolute quantity (overrides current value)"
            >
              <Pencil className="h-3.5 w-3.5" />
              Adjust quantity
            </button>
            <div className="ml-auto">
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
          </div>

          <div className="flex-1 overflow-auto">
            {error ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-red-400">
                Failed to load item history.
              </div>
            ) : isLoading ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-[var(--wms-muted)]">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-5 py-12 text-center font-mono text-sm text-[var(--wms-muted)]">
                No history yet — qty changes will appear here once syncs, counts, or POS events fire.
              </div>
            ) : (
              <table
                ref={tableRef}
                className="w-full min-w-[800px] border-collapse font-mono text-xs"
                style={{ tableLayout: pickTableLayout(colWidths) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                  <tr>
                    {[
                      { label: "When" },
                      { label: "Source" },
                      { label: "From → To" },
                      { label: "Δ" },
                      { label: "User" },
                      { label: "Notes" },
                    ].map((c, i) => {
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
                  {rows.map((r) => {
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
                  })}
                </tbody>
              </table>
            )}
          </div>

          {msg ? (
            <div className="border-t border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-5 py-2 text-xs text-[var(--wms-muted)]">
              {msg}
            </div>
          ) : null}
        </div>
      </div>

      {adjustOpen ? (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/70"
            onClick={() => !busy && setAdjustOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl">
              <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
                Adjust quantity
              </h3>
              <p className="mt-1 text-xs text-[var(--wms-muted)]">
                Sets a new absolute quantity. Overrides the current value, attributed to you in the history.
              </p>
              <div className="mt-4 grid gap-3 font-mono text-xs">
                <label className="grid gap-1">
                  <span className="text-[var(--wms-muted)]">New quantity</span>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={adjustValue}
                    onChange={(e) => setAdjustValue(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 tabular-nums text-[var(--wms-fg)]"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[var(--wms-muted)]">Notes (optional)</span>
                  <input
                    value={adjustNotes}
                    onChange={(e) => setAdjustNotes(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. recount after damage check"
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                  />
                </label>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setAdjustOpen(false)}
                  className="rounded-md border border-[var(--wms-border)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !adjustValue.trim()}
                  onClick={() => void submitAdjust()}
                  className="rounded-md border px-3 py-2 font-mono text-xs font-semibold hover:opacity-90 disabled:opacity-40"
                  style={{
                    borderColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 45%, transparent)",
                    backgroundColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 18%, var(--wms-surface-elevated))",
                    color: "oklch(82.8% 0.111 230.318)",
                  }}
                >
                  {busy ? "Saving…" : "Save override"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
