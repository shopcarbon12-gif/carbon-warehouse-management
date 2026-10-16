"use client";

import { useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { FileSpreadsheet, FileText, Radar } from "lucide-react";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type Tag = {
  epc: string;
  product: string | null;
  color: string | null;
  size: string | null;
  sku: string | null;
  bin: string | null;
  firstFoundAt: string | null;
  firstFoundBy: string | null;
  lastSeenAt: string | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as { unknown: Tag[] };
};

const et = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";

const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-accent)] hover:opacity-90 disabled:opacity-50 max-md:min-h-11";

/**
 * Reports → New Unknown tags (owner, 2026-10-16): every fresh tag a count or
 * reader found that was never recorded in the WMS, still waiting for a person.
 * Send them to Cloud + Geiger, find them, change them to LIVE — that takes
 * them off this list.
 */
export function UnknownTagsWorkspace() {
  const { data, error, isLoading } = useSWR("/api/reports/unknown-tags", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 10);

  const rows = useMemo(() => {
    const all = data?.unknown ?? [];
    const t = q.trim().toLowerCase();
    if (!t) return all;
    return all.filter((r) =>
      [r.epc, r.product, r.color, r.size, r.sku, r.bin, r.firstFoundBy].some((v) => (v ?? "").toLowerCase().includes(t)),
    );
  }, [data, q]);

  const toggle = (epc: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(epc)) n.delete(epc);
      else n.add(epc);
      return n;
    });

  const send = async () => {
    const epcs = selected.size ? [...selected] : rows.map((r) => r.epc);
    if (!epcs.length || busy) return;
    if (!window.confirm(`Send ${epcs.length} Unknown tag${epcs.length === 1 ? "" : "s"} to every handheld's Cloud + Geiger?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/handhelds/epc-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs }),
      });
      const j = (await res.json().catch(() => ({}))) as { handhelds?: number; warning?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Send failed");
      setMsg(j.warning ?? `Sent ${epcs.length} to ${j.handhelds ?? 0} handheld${j.handhelds === 1 ? "" : "s"}.`);
      setSelected(new Set());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  };

  const cols = ["", "EPC", "Product", "Color", "Size", "SKU", "Bin", "First found (ET)", "First found by", "Last seen (ET)"];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-[var(--wms-fg)]">
          {isLoading ? "Loading…" : `${data?.unknown.length ?? 0} waiting`}
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search EPC, product, SKU, bin, reader…"
          className="min-w-[220px] flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11"
        />
        <a href="/api/reports/unknown-tags?format=xlsx" className={btn}>
          <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
        </a>
        <a href="/api/reports/unknown-tags?format=pdf" className={btn}>
          <FileText className="h-3.5 w-3.5" /> PDF
        </a>
        <button type="button" onClick={() => void send()} disabled={busy || rows.length === 0} className={btn}>
          <Radar className="h-3.5 w-3.5" />
          {busy ? "Sending…" : selected.size ? `Cloud + Geiger (${selected.size})` : `Cloud + Geiger (all ${rows.length})`}
        </button>
      </div>
      {msg ? <p className="font-mono text-xs text-[var(--wms-muted)]">{msg}</p> : null}
      {error ? <p className="font-mono text-xs text-red-400">{String(error.message ?? error)}</p> : null}
      <DataTableContainer maxHeight="min(72vh, 720px)">
        <table ref={tableRef} className="w-full min-w-[1100px] border-collapse text-left text-sm" style={{ tableLayout: pickTableLayout(colWidths) }}>
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] max-md:text-xs uppercase text-[var(--wms-muted)]">
            <tr className="border-b border-[var(--wms-border)]">
              {cols.map((c, i) => {
                const w = colWidths[i];
                return (
                  <th key={c || "sel"} style={w !== null ? { width: w, minWidth: w } : undefined} className="relative overflow-hidden px-3 py-3">
                    {i === 0 ? (
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={rows.length > 0 && rows.every((r) => selected.has(r.epc))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.epc)) : new Set())}
                      />
                    ) : (
                      <span>{c}</span>
                    )}
                    <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  {isLoading ? "Loading…" : "No new Unknown tags waiting."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.epc} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Select ${r.epc}`} checked={selected.has(r.epc)} onChange={() => toggle(r.epc)} />
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`}>{r.epc}</td>
                  <td className={`${cellTruncate} px-3 py-2 text-xs`} title={r.product ?? ""}>{r.product ?? "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`}>{r.color ?? "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`}>{r.size ?? "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`}>{r.sku ?? "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`}>{r.bin ?? "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs tabular-nums text-[var(--wms-muted)]`}>{et(r.firstFoundAt)}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`} title={r.firstFoundBy ?? ""}>{r.firstFoundBy ?? "—"}</td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs tabular-nums text-[var(--wms-muted)]`}>{et(r.lastSeenAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </DataTableContainer>
    </div>
  );
}
