"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, X } from "lucide-react";
import {
  cellTruncate,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type LogRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

function metadataSummary(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "—";
  const m = meta as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.sku === "string") parts.push(`SKU ${m.sku}`);
  if (typeof m.qty === "number") parts.push(`qty ${m.qty}`);
  if (typeof m.printer_ip === "string") parts.push(m.printer_ip);
  if (m.add_to_inventory === true) parts.push("→ stock");
  if (typeof m.status_final === "string") parts.push(m.status_final);
  return parts.length ? parts.join(" · ") : JSON.stringify(meta).slice(0, 120);
}

function toCsv(rows: LogRow[]): string {
  const header = ["id", "created_at", "action", "entity", "summary", "metadata_json"];
  const lines = rows.map((r) => {
    const summary = metadataSummary(r.metadata).replaceAll('"', '""');
    const meta = JSON.stringify(r.metadata ?? {}).replaceAll('"', '""');
    return [
      r.id,
      r.created_at,
      r.action,
      r.entity,
      summary,
      meta,
    ]
      .map((c) => `"${String(c)}"`)
      .join(",");
  });
  return [header.join(","), ...lines].join("\n");
}

export function PrintLogsModal({ open, onClose }: Props) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 3);
  const [filter, setFilter] = useState("");
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(filter.trim()), 320);
    return () => window.clearTimeout(t);
  }, [filter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: "100" });
      if (debounced) q.set("q", debounced);
      const res = await fetch(`/api/rfid/print-logs?${q}`);
      if (!res.ok) {
        setRows([]);
        return;
      }
      const data = (await res.json()) as { rows?: LogRow[] };
      setRows(data.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [debounced]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const exportCsv = useCallback(() => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rfid-print-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close logs"
        className="fixed inset-0 z-[80] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div
          className="flex max-h-[min(90vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="print-logs-title"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[var(--wms-border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[var(--wms-muted)]" strokeWidth={2} />
              <h2 id="print-logs-title" className="text-sm font-semibold text-[var(--wms-fg)]">
                RFID print logs (rfid_print)
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.65rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={exportCsv}
                disabled={rows.length === 0}
                className="wms-btn-primary wms-btn-compact inline-flex items-center gap-1 font-mono disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                aria-label="Close"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
          <div className="border-b border-[var(--wms-border)] px-4 py-2">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by SKU, status, JSON fragment…"
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loading ? (
              <p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="p-4 text-center font-mono text-xs text-[var(--wms-muted)]">
                No rfid_print rows match this filter.
              </p>
            ) : (
              <table
                ref={tableRef}
                className="w-full min-w-[640px] border-collapse text-left text-xs"
                style={{ tableLayout: pickTableLayout(colWidths) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)]">
                  <tr className="border-b border-[var(--wms-border)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    {["When", "Action", "Summary"].map((label, i) => {
                      const w = colWidths[i];
                      return (
                        <th
                          key={label}
                          style={w !== null ? { width: w, minWidth: w } : undefined}
                          className="relative overflow-hidden px-2 py-2"
                        >
                          <span>{label}</span>
                          <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--wms-border)]/80">
                  {rows.map((r) => {
                    const summary = metadataSummary(r.metadata);
                    return (
                      <tr key={r.id} className="text-[var(--wms-fg)]">
                        <td className={`${cellTruncate} px-2 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]`}>
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                        <td className={`${cellTruncate} px-2 py-2 font-mono text-[0.65rem] text-teal-500/90`} title={r.action}>
                          {r.action}
                        </td>
                        <td className={`${cellTruncate} px-2 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]`} title={summary}>
                          {summary}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
