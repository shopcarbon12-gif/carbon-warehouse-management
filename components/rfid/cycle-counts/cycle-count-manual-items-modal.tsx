"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Boxes, RefreshCw, X } from "lucide-react";
import {
  cellTruncate,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type ManualRow = {
  custom_sku_id: string;
  matrix_id: string;
  matrix_ls_system_id: string | null;
  sku_ls_system_id: string | null;
  sku: string;
  upc: string | null;
  name: string;
  color: string | null;
  size: string | null;
  expected_qty: number;
  count_qty: number | null;
  state: "pending" | "draft" | "committed" | string;
};

type ManualResponse = {
  rows: ManualRow[];
  count: number;
  session_status: string;
};

const fetcher = async (url: string): Promise<ManualResponse> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return (await r.json()) as ManualResponse;
};

function deltaBadge(expected: number, count: number | null): { label: string; cls: string } {
  if (count == null) return { label: "—", cls: "text-[var(--wms-muted)]" };
  const d = count - expected;
  if (d === 0) return { label: "matched", cls: "text-green-300" };
  if (d > 0) return { label: `added here +${d}`, cls: "text-green-300" };
  return { label: `missing ${d}`, cls: "text-red-300" };
}

function stateBadge(row: ManualRow): { text: string; cls: string } {
  const d = deltaBadge(row.expected_qty, row.count_qty);
  if (row.state === "committed") {
    return { text: `${d.label} · committed`, cls: d.cls };
  }
  if (row.state === "draft") {
    return { text: `${d.label} · draft`, cls: d.cls };
  }
  return { text: d.label, cls: d.cls };
}

export function CycleCountManualItemsModal({
  sessionId,
  sessionName,
  onClose,
  onCommitted,
}: {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  onCommitted?: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<ManualResponse>(
    `/api/rfid/cycle-counts/sessions/${sessionId}/manual-items`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const sessionRows = useMemo(() => data?.rows ?? [], [data]);
  const closed =
    data?.session_status === "committed" || data?.session_status === "canceled";

  /* Local edit buffer keyed by custom_sku_id; null = cleared, undefined = untouched. */
  const [edits, setEdits] = useState<Record<string, number | null | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 8);

  /* Apply edits first, THEN filter — so the operator's typed counts persist
     across filter changes (rows just hide/show, the buffer keeps them). */
  const rowsForRender = useMemo(() => {
    const enriched = sessionRows.map((r) => {
      const edit = edits[r.custom_sku_id];
      const effectiveCount = edit === undefined ? r.count_qty : edit;
      return { ...r, count_qty: effectiveCount };
    });
    const q = filter.trim().toLowerCase();
    if (!q) return enriched;
    return enriched.filter((r) => {
      const hay = [
        r.sku,
        r.upc ?? "",
        r.name ?? "",
        r.color ?? "",
        r.size ?? "",
        r.matrix_ls_system_id ?? "",
        r.sku_ls_system_id ?? "",
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [sessionRows, edits, filter]);

  const dirtyEntries = useMemo(() => {
    const out: { customSkuId: string; countQty: number | null }[] = [];
    for (const [customSkuId, value] of Object.entries(edits)) {
      if (value === undefined) continue;
      out.push({ customSkuId, countQty: value });
    }
    return out;
  }, [edits]);

  const setCell = useCallback((customSkuId: string, raw: string) => {
    const cleaned = raw.replace(/\D/g, "").slice(0, 3);
    setEdits((prev) => ({
      ...prev,
      [customSkuId]: cleaned === "" ? null : Number.parseInt(cleaned, 10),
    }));
  }, []);

  const doSave = useCallback(async () => {
    if (busy || closed) return;
    if (dirtyEntries.length === 0) {
      setMsg("Nothing to save.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/rfid/cycle-counts/sessions/${sessionId}/manual-items`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: dirtyEntries }),
        },
      );
      const j = (await res.json()) as { saved?: number; cleared?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      setMsg(`Saved ${j.saved ?? 0} draft entr${(j.saved ?? 0) === 1 ? "y" : "ies"}${
        j.cleared ? `, cleared ${j.cleared}` : ""
      }.`);
      setEdits({});
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [busy, closed, dirtyEntries, sessionId, mutate]);

  const doFinish = useCallback(async () => {
    if (busy || closed) return;
    setBusy(true);
    setMsg(null);
    try {
      /* If the operator made local edits without clicking Save first, persist
       * them as drafts before commit so nothing is silently dropped. */
      if (dirtyEntries.length > 0) {
        const sv = await fetch(
          `/api/rfid/cycle-counts/sessions/${sessionId}/manual-items`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entries: dirtyEntries }),
          },
        );
        if (!sv.ok) {
          const j = (await sv.json()) as { error?: string };
          throw new Error(j.error ?? "Save before finish failed");
        }
      }
      const res = await fetch(
        `/api/rfid/cycle-counts/sessions/${sessionId}/manual-items/finish`,
        { method: "POST" },
      );
      const j = (await res.json()) as { committed?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Finish failed");
      setEdits({});
      await mutate();
      onCommitted?.();
      /* Close the popup once the commit lands so the operator returns to
         the cycle count workspace. Successful entries are now visible in
         each row's Item History via the catalog MANUAL badge. */
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Finish failed");
    } finally {
      setBusy(false);
    }
  }, [busy, closed, dirtyEntries, sessionId, mutate, onCommitted, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <Boxes className="h-5 w-5" style={{ color: "oklch(82.8% 0.111 230.318)" }} />
              <div>
                <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
                  Manual Items · session {sessionName}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--wms-muted)]">
                  Non-RFID SKUs — type the counted qty for each. Save keeps drafts under this session. Finish commits the entered counts as overrides.
                </p>
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
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by SKU, UPC, name, color, size…"
              className="w-full max-w-md rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] max-md:text-base"
            />
            <span className="font-mono text-xs text-[var(--wms-muted)]">
              {data
                ? filter.trim()
                  ? `${rowsForRender.length} / ${data.count} match`
                  : `${data.count} manual SKU${data.count === 1 ? "" : "s"} at this location`
                : ""}
              {dirtyEntries.length > 0 ? ` · ${dirtyEntries.length} unsaved` : ""}
            </span>
            <div className="ml-auto flex gap-2">
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
                Failed to load manual items.
              </div>
            ) : isLoading ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-[var(--wms-muted)]">
                Loading…
              </div>
            ) : sessionRows.length === 0 ? (
              <div className="px-5 py-12 text-center font-mono text-sm text-[var(--wms-muted)]">
                No manual SKUs at this location. Mark UPCs as manual in Catalog → More → Manual Items.
              </div>
            ) : rowsForRender.length === 0 ? (
              <div className="px-5 py-12 text-center font-mono text-sm text-[var(--wms-muted)]">
                No SKUs match &ldquo;{filter}&rdquo;.
              </div>
            ) : (
              <table
                ref={tableRef}
                className="w-full min-w-[1000px] border-collapse font-mono text-xs max-md:min-w-0"
                style={{ tableLayout: pickTableLayout(colWidths) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)] max-md:text-xs">
                  <tr>
                    {[
                      { label: "SKU" },
                      { label: "UPC", hideMobile: true },
                      { label: "Description" },
                      { label: "Color", hideMobile: true },
                      { label: "Size", hideMobile: true },
                      { label: "Expected qty", align: "center" },
                      { label: "Count qty", align: "center" },
                      { label: "State" },
                    ].map((c, i) => {
                      const w = colWidths[i];
                      return (
                        <th
                          key={c.label}
                          style={w !== null ? { width: w, minWidth: w } : undefined}
                          className={`relative overflow-hidden px-3 py-2 ${c.align === "center" ? "text-center" : "text-left"}${c.hideMobile ? " max-md:hidden" : ""}`}
                        >
                          <span>{c.label}</span>
                          <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rowsForRender.map((r) => {
                    const badge = stateBadge(r);
                    const committed = r.state === "committed";
                    return (
                      <tr
                        key={r.custom_sku_id}
                        className={`border-b border-[var(--wms-border)]/40 ${
                          committed ? "opacity-70" : ""
                        } hover:bg-[var(--wms-surface-elevated)]/40`}
                      >
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-fg)]`}>{r.sku}</td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)] max-md:hidden`}>
                          {r.upc ?? "—"}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-fg)]`} title={r.name}>
                          {r.name}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)] max-md:hidden`}>
                          {r.color?.trim() || "—"}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)] max-md:hidden`}>
                          {r.size?.trim() || "—"}
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums text-[var(--wms-fg)]">
                          {r.expected_qty}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={3}
                            disabled={busy || closed || committed}
                            value={r.count_qty == null ? "" : String(r.count_qty)}
                            onChange={(e) => setCell(r.custom_sku_id, e.target.value)}
                            className="w-16 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-center tabular-nums text-[var(--wms-fg)] disabled:cursor-not-allowed disabled:opacity-50 max-md:py-2 max-md:text-base"
                            aria-label={`Count qty for ${r.sku}`}
                          />
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 ${badge.cls}`}>
                          {badge.text}
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

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--wms-border)] px-5 py-3">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || closed || dirtyEntries.length === 0}
              onClick={() => void doSave()}
              className="rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={busy || closed}
              onClick={() => void doFinish()}
              className="rounded-md border px-4 py-2 font-mono text-xs font-semibold shadow-sm hover:opacity-90 disabled:opacity-40"
              style={{
                borderColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 45%, transparent)",
                backgroundColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 18%, var(--wms-surface-elevated))",
                color: "oklch(82.8% 0.111 230.318)",
              }}
              title="Commit entered counts as overrides — writes manual_item_qty + history rows"
            >
              {busy ? "Finishing…" : "Finish"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
