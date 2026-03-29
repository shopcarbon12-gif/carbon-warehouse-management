"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileText, X } from "lucide-react";

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
          className="flex max-h-[min(90vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-800 bg-zinc-950 shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="print-logs-title"
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-slate-500" strokeWidth={2} />
              <h2 id="print-logs-title" className="text-sm font-semibold text-slate-100">
                RFID print logs (rfid_print)
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded border border-slate-700 px-2 py-1 font-mono text-[0.65rem] text-slate-300 hover:bg-zinc-800"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={exportCsv}
                disabled={rows.length === 0}
                className="inline-flex items-center gap-1 rounded border border-teal-600/50 bg-teal-950/30 px-2 py-1 font-mono text-[0.65rem] text-teal-200 disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-2 text-slate-400 hover:bg-zinc-800 hover:text-slate-100"
                aria-label="Close"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
          <div className="border-b border-slate-800 px-4 py-2">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by SKU, status, JSON fragment…"
              className="w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loading ? (
              <p className="p-4 font-mono text-xs text-slate-500">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="p-4 text-center font-mono text-xs text-slate-600">
                No rfid_print rows match this filter.
              </p>
            ) : (
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-zinc-900">
                  <tr className="border-b border-slate-800 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
                    <th className="px-2 py-2">When</th>
                    <th className="px-2 py-2">Action</th>
                    <th className="px-2 py-2">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {rows.map((r) => (
                    <tr key={r.id} className="text-slate-300">
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-[0.65rem] text-slate-500">
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td className="px-2 py-2 font-mono text-[0.65rem] text-teal-500/90">
                        {r.action}
                      </td>
                      <td className="max-w-md px-2 py-2 font-mono text-[0.65rem] text-slate-400">
                        {metadataSummary(r.metadata)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
