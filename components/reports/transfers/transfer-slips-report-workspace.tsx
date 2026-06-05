"use client";

/**
 * /reports/transfers/{out|in} workspace — Senitron-style slip list with
 * filters, search, status pills, and an Export modal (PDF / CSV / Both).
 *
 * Read-only on its own; clicking a slip# opens its PDF in a new tab.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Search, ChevronDown, ChevronUp, FileText, Download, X } from "lucide-react";

type SlipRow = {
  id: string;
  slip_number: number | null;
  state: string;
  source_location_code: string;
  source_location_name: string;
  destination_location_code: string;
  destination_location_name: string;
  created_at: string;
  received_at: string | null;
  rfid_count: number;
  manual_count: number;
  sent_qty: number;
  received_qty: number;
  missing_qty: number;
  doc_number: string | null;
  ref_number: string | null;
  created_by_email: string | null;
  /** "First L." display names (server-formatted) — use these, never the email. */
  created_by_name: string | null;
  received_by_name: string | null;
};

type ListResponse = {
  rows: SlipRow[];
  total: number;
  status_counts: { all: number; pending: number; partially_received: number; received: number; cancelled: number };
};

const fetcher = async (url: string): Promise<ListResponse> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? r.statusText);
  }
  return (await r.json()) as ListResponse;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function StatusPill({ state }: { state: string }) {
  const label =
    state === "in-transit" ? "Pending"
      : state === "partially_received" ? "Partial"
        : state === "received" ? "Received"
          : state === "cancelled" ? "Cancelled" : state;
  const cls =
    state === "received" ? "bg-emerald-500/15 text-emerald-300"
      : state === "partially_received" ? "bg-amber-500/15 text-amber-300"
        : state === "cancelled" ? "bg-red-500/15 text-red-300"
          : "bg-zinc-500/15 text-zinc-300";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[0.6rem] uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  );
}

type Props = { direction: "out" | "in" };

export function TransferSlipsReportWorkspace({ direction }: Props) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [stateFilter, setStateFilter] = useState<"all" | "in-transit" | "partially_received" | "received" | "cancelled">("all");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [shippedFrom, setShippedFrom] = useState("");
  const [shippedTo, setShippedTo] = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [receivedTo, setReceivedTo] = useState("");
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, stateFilter, shippedFrom, shippedTo, receivedFrom, receivedTo]);

  const url = useMemo(() => {
    const p = new URLSearchParams({
      direction,
      page: String(page),
      limit: String(limit),
      state: stateFilter,
    });
    if (debouncedQ) p.set("q", debouncedQ);
    if (shippedFrom) p.set("shippedFrom", shippedFrom);
    if (shippedTo) p.set("shippedTo", shippedTo);
    if (receivedFrom) p.set("receivedFrom", receivedFrom);
    if (receivedTo) p.set("receivedTo", receivedTo);
    return `/api/reports/transfers?${p}`;
  }, [direction, page, limit, debouncedQ, stateFilter, shippedFrom, shippedTo, receivedFrom, receivedTo]);

  const { data, error, isLoading } = useSWR<ListResponse>(url, fetcher, { revalidateOnFocus: false });
  const rows = data?.rows ?? [];
  const counts = data?.status_counts ?? { all: 0, pending: 0, partially_received: 0, received: 0, cancelled: 0 };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));

  const openSlipPdf = (id: string) => {
    window.open(`/api/operations/transfers/${id}/pdf?autoprint=1`, "_blank", "noopener");
  };

  const downloadSlipCsv = (id: string) => {
    window.open(`/api/operations/transfers/${id}/csv`, "_blank", "noopener");
  };

  const StatusPillBtn = ({
    label,
    n,
    active,
    onClick,
    color,
  }: {
    label: string;
    n: number;
    active: boolean;
    onClick: () => void;
    color: "all" | "amber" | "teal" | "emerald" | "red";
  }) => {
    const baseCls = active
      ? "border-[var(--wms-accent)]/60 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] text-[var(--wms-accent)]"
      : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 text-[var(--wms-fg)] hover:border-teal-500/40";
    const colorCls =
      color === "amber" ? "text-amber-300"
        : color === "teal" ? "text-teal-300"
          : color === "emerald" ? "text-emerald-300"
            : color === "red" ? "text-red-300" : "text-[var(--wms-fg)]";
    return (
      <button
        type="button"
        onClick={onClick}
        className={`rounded border px-3 py-1.5 font-mono text-xs ${baseCls}`}
      >
        <span className="text-[var(--wms-muted)] uppercase tracking-wider text-[0.6rem]">{label}: </span>
        <span className={`tabular-nums font-semibold ${colorCls}`}>{n}</span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {/* Top bar — search + filter pills + export */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-1 min-w-[280px] items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 focus-within:border-teal-500/50">
          <Search className="h-4 w-4 text-[var(--wms-muted)]" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search slip #, EPC, custom SKU, UPC, item name…"
            className="w-full bg-transparent font-mono text-xs text-[var(--wms-fg)] outline-none placeholder:text-[var(--wms-muted)]/70"
          />
        </div>
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <StatusPillBtn label="All" n={counts.all} color="all" active={stateFilter === "all"} onClick={() => setStateFilter("all")} />
        <StatusPillBtn label="Pending" n={counts.pending} color="amber" active={stateFilter === "in-transit"} onClick={() => setStateFilter("in-transit")} />
        <StatusPillBtn label="Partially Received" n={counts.partially_received} color="teal" active={stateFilter === "partially_received"} onClick={() => setStateFilter("partially_received")} />
        <StatusPillBtn label="Received" n={counts.received} color="emerald" active={stateFilter === "received"} onClick={() => setStateFilter("received")} />
        <StatusPillBtn label="Undo" n={counts.cancelled} color="red" active={stateFilter === "cancelled"} onClick={() => setStateFilter("cancelled")} />
      </div>

      {/* Advanced filter — date ranges */}
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center justify-between px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
        >
          <span>Advanced filters</span>
          {advancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {advancedOpen ? (
          <div className="grid gap-3 border-t border-[var(--wms-border)] p-4 sm:grid-cols-4">
            <label className="block font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Shipped date — from
              <input type="date" value={shippedFrom} onChange={(e) => setShippedFrom(e.target.value)} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]" />
            </label>
            <label className="block font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Shipped date — to
              <input type="date" value={shippedTo} onChange={(e) => setShippedTo(e.target.value)} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]" />
            </label>
            <label className="block font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Received date — from
              <input type="date" value={receivedFrom} onChange={(e) => setReceivedFrom(e.target.value)} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]" />
            </label>
            <label className="block font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Received date — to
              <input type="date" value={receivedTo} onChange={(e) => setReceivedTo(e.target.value)} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]" />
            </label>
            <div className="sm:col-span-4">
              <button
                type="button"
                onClick={() => {
                  setShippedFrom("");
                  setShippedTo("");
                  setReceivedFrom("");
                  setReceivedTo("");
                }}
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1 font-mono text-[0.65rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              >
                Clear date filters
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
        <div className="overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
              <tr className="border-b border-[var(--wms-border)]">
                <th className="px-3 py-2"></th>
                <th className="px-3 py-2">Slip #</th>
                <th className="px-3 py-2">Created at</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Received date</th>
                <th className="px-3 py-2">DOC #</th>
                <th className="px-3 py-2">REF #</th>
                <th className="px-3 py-2 text-right">Sent QTY</th>
                <th className="px-3 py-2 text-right">Received QTY</th>
                <th className="px-3 py-2 text-right">Missing QTY</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
              {isLoading && !data ? (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-[var(--wms-muted)]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-red-400/90">{(error as Error).message}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-[var(--wms-muted)]">No transfers match the current filters.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="hover:bg-[var(--wms-surface-elevated)]/50">
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => openSlipPdf(r.id)}
                      className="rounded border border-[var(--wms-border)] px-1.5 py-1 text-[0.6rem] text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                      title="Open printable slip in new tab"
                    >
                      <FileText className="h-3 w-3" />
                    </button>
                  </td>
                  <td className="px-3 py-1.5 tabular-nums">
                    <button
                      type="button"
                      onClick={() => openSlipPdf(r.id)}
                      className="text-[var(--wms-accent)] hover:underline"
                    >
                      {r.slip_number ?? "—"}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-[var(--wms-muted)]">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-1.5">
                    <div>{r.source_location_code}</div>
                    <div className="text-[0.6rem] text-[var(--wms-muted)]">{r.source_location_name}</div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div>{r.destination_location_code}</div>
                    <div className="text-[0.6rem] text-[var(--wms-muted)]">{r.destination_location_name}</div>
                  </td>
                  <td className="px-3 py-1.5 text-[var(--wms-muted)]">{formatDate(r.received_at)}</td>
                  <td className="px-3 py-1.5 text-[var(--wms-muted)]">{r.doc_number ?? "—"}</td>
                  <td className="px-3 py-1.5 text-[var(--wms-muted)]">{r.ref_number ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.sent_qty}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">{r.received_qty}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-red-400/90">{r.missing_qty}</td>
                  <td className="px-3 py-1.5"><StatusPill state={r.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {(data?.total ?? 0) > 0 ? (
        <div className="flex items-center justify-between font-mono text-[0.65rem] text-[var(--wms-muted)]">
          <span>{data?.total} row{data?.total === 1 ? "" : "s"} · page {page} / {totalPages}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1 disabled:opacity-40">Previous</button>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      ) : null}

      {/* Export modal */}
      {exportOpen ? (
        <ExportModal
          onClose={() => setExportOpen(false)}
          onExportCsv={() => {
            for (const r of rows) downloadSlipCsv(r.id);
            setExportOpen(false);
          }}
          onExportPdf={() => {
            for (const r of rows) openSlipPdf(r.id);
            setExportOpen(false);
          }}
          rowCount={rows.length}
        />
      ) : null}
    </div>
  );
}

function ExportModal({
  onClose,
  onExportCsv,
  onExportPdf,
  rowCount,
}: {
  onClose: () => void;
  onExportCsv: () => void;
  onExportPdf: () => void;
  rowCount: number;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[80] bg-black/60"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Export</h2>
            <button type="button" onClick={onClose} className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"><X className="h-4 w-4" /></button>
          </div>
          <div className="space-y-3 px-4 py-4">
            <p className="font-mono text-xs text-[var(--wms-muted)]">
              Files generate immediately — no email step. PDF opens in a new tab; CSV downloads.
              {rowCount === 0 ? " (No rows match the current filters — pick a slip first.)" : ` Will export ${rowCount} slip${rowCount === 1 ? "" : "s"} on this page.`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={rowCount === 0}
                onClick={onExportPdf}
                className="flex-1 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-40"
              >
                Export as .PDF
              </button>
              <button
                type="button"
                disabled={rowCount === 0}
                onClick={onExportCsv}
                className="flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:opacity-90 disabled:opacity-40"
              >
                Export as .CSV
              </button>
            </div>
          </div>
          <div className="flex border-t border-[var(--wms-border)] px-4 py-3">
            <button type="button" onClick={onClose} className="ml-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-1.5 font-mono text-xs text-[var(--wms-fg)] hover:opacity-90">Close</button>
          </div>
        </div>
      </div>
    </>
  );
}
