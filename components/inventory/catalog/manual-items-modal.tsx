"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Boxes, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  cellTruncate,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type ManualMatrixRow = {
  matrix_id: string;
  matrix_upc: string | null;
  name: string;
  brand: string | null;
  sku_count: number;
  retail_price: string | null;
  bin_location: string | null;
  qty: number;
};

type ManualMatrixListResponse = { rows: ManualMatrixRow[]; count: number };

type SearchHit = {
  matrix_id: string;
  matrix_ls_system_id: string | null;
  matrix_upc: string | null;
  name: string;
  vendor: string | null;
  sku_count: number;
};

type SearchResponse = { rows: SearchHit[]; count: number };

const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return (await r.json()) as T;
};

export function ManualItemsModal({
  onClose,
  onMutated,
}: {
  onClose: () => void;
  onMutated?: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<ManualMatrixListResponse>(
    "/api/inventory/catalog/manual-items",
    fetcher,
    { revalidateOnFocus: false },
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 8);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Search-to-add
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!debounced) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    fetch(
      `/api/inventory/catalog/manual-items/search?q=${encodeURIComponent(debounced)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json() as Promise<SearchResponse>)
      .then((j) => {
        if (cancelled) return;
        setHits(j.rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setHits([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Close picker on click-outside
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: PointerEvent) => {
      const el = searchBoxRef.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [pickerOpen]);

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.matrix_id));
  const someChecked = rows.some((r) => selected.has(r.matrix_id));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        for (const r of rows) next.delete(r.matrix_id);
      } else {
        for (const r of rows) next.add(r.matrix_id);
      }
      return next;
    });
  }, [allChecked, rows]);

  const toggleOne = useCallback((matrixId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(matrixId)) next.delete(matrixId);
      else next.add(matrixId);
      return next;
    });
  }, []);

  const addManual = useCallback(
    async (hit: SearchHit) => {
      if (busy) return;
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch("/api/inventory/catalog/manual-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matrixIds: [hit.matrix_id] }),
        });
        const j = (await res.json()) as { updated?: number; error?: string };
        if (!res.ok) throw new Error(j.error ?? "Add failed");
        setMsg(`Added ${hit.matrix_upc ?? hit.name} as manual.`);
        setSearch("");
        setDebounced("");
        setHits([]);
        setPickerOpen(false);
        await mutate();
        onMutated?.();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "Add failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, mutate, onMutated],
  );

  const removeSelected = useCallback(async () => {
    if (selected.size === 0 || busy) return;
    const ids = [...selected];
    const ok = window.confirm(
      `Remove ${ids.length} item${ids.length === 1 ? "" : "s"} from Manual Items?\n\nTheir SKUs will go back to RFID/EPC tracking in the catalog.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/inventory/catalog/manual-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixIds: ids }),
      });
      const j = (await res.json()) as { updated?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Remove failed");
      setMsg(`Removed ${j.updated ?? 0} item${(j.updated ?? 0) === 1 ? "" : "s"}.`);
      setSelected(new Set());
      await mutate();
      onMutated?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }, [selected, busy, mutate, onMutated]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 max-md:items-stretch max-md:p-0">
        <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <Boxes className="h-5 w-5" style={{ color: "oklch(82.8% 0.111 230.318)" }} />
              <div>
                <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
                  Manual Items {data ? `(${data.count})` : ""}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--wms-muted)]">
                  Non-RFID UPCs. Qty comes from Lightspeed on-hand + cycle count adjustments. Adding a UPC marks every SKU under it as manual in the catalog.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-1.5 text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Search-to-add */}
          <div className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-5 py-3">
            <div ref={searchBoxRef} className="relative">
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPickerOpen(true);
                }}
                onFocus={() => setPickerOpen(true)}
                placeholder="Search to add: name, SKU, UPC, system ID…"
                className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] max-md:text-base"
              />
              {pickerOpen && debounced ? (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] shadow-xl">
                  {searching ? (
                    <div className="px-3 py-3 font-mono text-xs text-[var(--wms-muted)]">
                      Searching…
                    </div>
                  ) : hits.length === 0 ? (
                    <div className="px-3 py-3 font-mono text-xs text-[var(--wms-muted)]">
                      No matches (already-manual UPCs are hidden).
                    </div>
                  ) : (
                    <ul>
                      {hits.map((h) => (
                        <li key={h.matrix_id}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void addManual(h)}
                            className="flex w-full items-start justify-between gap-3 border-b border-[var(--wms-border)]/40 px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] last:border-0 hover:bg-[color-mix(in_srgb,var(--wms-accent)_10%,var(--wms-surface-elevated))] disabled:opacity-40"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-teal-400/90">
                                  {h.matrix_upc ?? "—"}
                                </span>
                                <span className="truncate text-[var(--wms-fg)]">{h.name}</span>
                              </div>
                              <div className="mt-0.5 text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">
                                {h.vendor ? `${h.vendor} · ` : ""}
                                {h.sku_count} SKU{h.sku_count === 1 ? "" : "s"}
                                {h.matrix_ls_system_id ? ` · sys ${h.matrix_ls_system_id}` : ""}
                              </div>
                            </div>
                            <Plus
                              className="h-3.5 w-3.5 shrink-0"
                              style={{ color: "oklch(82.8% 0.111 230.318)" }}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-5 py-3">
            <label className="flex cursor-pointer items-center gap-2 font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = !allChecked && someChecked;
                }}
                onChange={toggleAll}
                className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
              />
              Select all
            </label>
            <span className="ml-2 font-mono text-xs text-[var(--wms-muted)]">
              {selected.size > 0 ? `${selected.size} selected` : " "}
            </span>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => void mutate()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] max-md:min-h-11"
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || busy}
                onClick={() => void removeSelected()}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-400/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-red-300 hover:bg-red-400/20 disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11"
                title="Un-mark as manual (back to RFID/EPC tracking)"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto max-md:overscroll-contain">
            {error ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-red-400">
                Failed to load manual items.
              </div>
            ) : isLoading ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-[var(--wms-muted)]">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-5 py-12 text-center font-mono text-sm text-[var(--wms-muted)]">
                No manual items yet — search above to add a UPC.
              </div>
            ) : (
              <>
              {/* Mobile card list (<md) — same rows/selection as the table below. */}
              <ul className="divide-y divide-[var(--wms-border)]/40 font-mono md:hidden">
                {rows.map((r) => {
                  const checked = selected.has(r.matrix_id);
                  return (
                    <li
                      key={r.matrix_id}
                      className={`flex items-start gap-3 px-4 py-3 ${
                        checked ? "bg-[color-mix(in_srgb,var(--wms-accent)_6%,transparent)]" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(r.matrix_id)}
                        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[var(--wms-accent)]"
                        aria-label={`Select ${r.matrix_upc ?? r.name}`}
                      />
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="font-semibold text-teal-400/90">{r.matrix_upc ?? "—"}</div>
                        <div className="mt-0.5 break-words text-[var(--wms-fg)]">{r.name}</div>
                        <div className="mt-1 text-[var(--wms-muted)]">
                          {r.brand ? `${r.brand} · ` : ""}
                          {r.sku_count} SKU{r.sku_count === 1 ? "" : "s"}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[var(--wms-muted)]">
                          <span>
                            Qty <span className="tabular-nums text-[var(--wms-fg)]">{r.qty}</span>
                          </span>
                          <span>
                            Price{" "}
                            <span className="tabular-nums text-[var(--wms-fg)]">
                              {r.retail_price
                                ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(r.retail_price))
                                : "—"}
                            </span>
                          </span>
                          <span>
                            Bin <span className="text-[var(--wms-fg)]">{r.bin_location ?? "—"}</span>
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <table
                ref={tableRef}
                className="w-full min-w-[900px] border-collapse font-mono text-xs max-md:hidden"
                style={{ tableLayout: pickTableLayout(colWidths) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                  <tr>
                    {[
                      { label: "", noResize: true },
                      { label: "UPC" },
                      { label: "Item name" },
                      { label: "Brand" },
                      { label: "SKUs" },
                      { label: "Retail price" },
                      { label: "Bin" },
                      { label: "Qty" },
                    ].map((c, i) => {
                      const w = colWidths[i];
                      return (
                        <th
                          key={c.label || `col-${i}`}
                          style={w !== null ? { width: w, minWidth: w } : undefined}
                          className="relative overflow-hidden px-3 py-2 text-left"
                        >
                          <span>{c.label}</span>
                          {c.noResize ? null : (
                            <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const checked = selected.has(r.matrix_id);
                    return (
                      <tr
                        key={r.matrix_id}
                        className={`border-b border-[var(--wms-border)]/40 ${
                          checked ? "bg-[color-mix(in_srgb,var(--wms-accent)_6%,transparent)]" : ""
                        } hover:bg-[var(--wms-surface-elevated)]/40`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleOne(r.matrix_id)}
                            className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
                            aria-label={`Select ${r.matrix_upc ?? r.name}`}
                          />
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.matrix_upc ?? ""}>
                          {r.matrix_upc ?? "—"}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-fg)]`} title={r.name}>
                          {r.name}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>
                          {r.brand ?? "—"}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 tabular-nums text-[var(--wms-muted)]`}>
                          {r.sku_count}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 tabular-nums text-[var(--wms-fg)]`}>
                          {r.retail_price
                            ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(r.retail_price))
                            : "—"}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.bin_location ?? ""}>
                          {r.bin_location ?? "—"}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 tabular-nums text-[var(--wms-fg)]`}>
                          {r.qty}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}
          </div>

          {msg ? (
            <div className="border-t border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-5 py-2 text-xs text-[var(--wms-muted)]">
              {msg}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
