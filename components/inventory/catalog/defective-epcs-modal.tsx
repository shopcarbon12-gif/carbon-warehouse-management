"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Download, EyeOff, RefreshCw, Search, Send, X } from "lucide-react";
import {
  cellTruncate,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

type DefectiveRow = {
  epc: string;
  system_id_raw: string | null;
  system_id_padded: string;
  serial_raw: string | null;
  decode_reason: string | null;
  first_scanned_at: string | null;
  last_seen_at: string | null;
  source: string | null;
  source_device_label: string | null;
  status: string;
  status_label: string;
};

type DefectiveResponse = {
  rows: DefectiveRow[];
  count: number;
  capped: boolean;
};

const fetcher = async (url: string): Promise<DefectiveResponse> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return r.json() as Promise<DefectiveResponse>;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ageDaysFrom(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return null;
  const ms = Date.now() - d;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function sourceLabel(s: string | null): string {
  if (!s) return "—";
  switch (s) {
    case "fixed_reader": return "Fixed reader";
    case "handheld":     return "Handheld";
    case "transfer":     return "Transfer";
    case "manual":       return "Manual";
    case "cycle_count":  return "Cycle count";
    default:             return s;
  }
}

function csvEscape(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function DefectiveEpcsModal({ onClose }: { onClose: () => void }) {
  const { data, error, isLoading, mutate } = useSWR<DefectiveResponse>(
    "/api/inventory/catalog/defective-epcs",
    fetcher,
    { revalidateOnFocus: false },
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 9);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Search + sort UI state. Both client-side — applies to the in-memory
  // rows pulled from the modal's single GET. Cheap on the modal's typical
  // page size (server-side cap is in the thousands).
  const [search, setSearch] = useState("");
  // Sort key matches one of the column keys below; `null` = no sort
  // applied (server-default order shown). Clicking a column header
  // cycles: <none> → asc → desc → asc → desc … (column switch resets
  // to asc on the new column).
  type SortKey =
    | "epc"
    | "system_id"
    | "first_scanned_at"
    | "last_seen_at"
    | "age"
    | "source"
    | "device"
    | "status";
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev !== key) {
        // Switching column — start fresh at asc.
        setSortDir("asc");
        return key;
      }
      // Same column — flip direction.
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return prev;
    });
  }, []);

  // Filtered + sorted rows. Search is case-insensitive substring across
  // the columns the operator can see (epc / system id / decode reason /
  // serial / source label / device label / status label). Sorting uses
  // a column-appropriate comparator (string vs date).
  const displayRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows;
    if (q) {
      out = rows.filter((r) => {
        const haystack = [
          r.epc,
          r.system_id_padded,
          r.system_id_raw ?? "",
          r.serial_raw ?? "",
          r.decode_reason ?? "",
          sourceLabel(r.source),
          r.source_device_label ?? "",
          r.status_label,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      const cmp = (a: DefectiveRow, b: DefectiveRow): number => {
        const k = sortKey;
        // Date columns — both first_scanned_at and last_seen_at are
        // ISO strings; "" / null sorts last regardless of direction.
        if (k === "first_scanned_at" || k === "last_seen_at" || k === "age") {
          // `age` is derived from first_scanned_at and is just the
          // reverse-time view (newer = lower age); reusing first_scanned_at
          // as the sort key with the same direction gives the operator
          // exactly what they expect when they sort the Age column.
          const fa = k === "last_seen_at" ? a.last_seen_at : a.first_scanned_at;
          const fb = k === "last_seen_at" ? b.last_seen_at : b.first_scanned_at;
          const ta = fa ? new Date(fa).getTime() : Number.NaN;
          const tb = fb ? new Date(fb).getTime() : Number.NaN;
          const aMissing = Number.isNaN(ta);
          const bMissing = Number.isNaN(tb);
          if (aMissing && bMissing) return 0;
          if (aMissing) return 1; // missing → after present, regardless of dir
          if (bMissing) return -1;
          return (ta - tb) * dir;
        }
        // String comparators.
        const pick = (r: DefectiveRow): string => {
          switch (k) {
            case "epc": return r.epc;
            case "system_id": return r.decode_reason ?? r.system_id_padded ?? "";
            case "source": return sourceLabel(r.source);
            case "device": return r.source_device_label ?? "";
            case "status": return r.status_label;
          }
        };
        const sa = pick(a).toLowerCase();
        const sb = pick(b).toLowerCase();
        if (sa < sb) return -1 * dir;
        if (sa > sb) return 1 * dir;
        return 0;
      };
      // toSorted would be cleaner but lib.es2023 isn't guaranteed here;
      // copy + in-place sort for compatibility.
      out = [...out].sort(cmp);
    }
    return out;
  }, [rows, search, sortKey, sortDir]);

  // Select-all operates on the VISIBLE rows (post-search, post-sort) so
  // typing in the search box and hitting Select-all only picks up the
  // matches the operator is looking at.
  const allChecked = displayRows.length > 0 && displayRows.every((r) => selected.has(r.epc));
  const someChecked = displayRows.some((r) => selected.has(r.epc));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        for (const r of displayRows) next.delete(r.epc);
      } else {
        for (const r of displayRows) next.add(r.epc);
      }
      return next;
    });
  }, [allChecked, displayRows]);

  const toggleOne = useCallback((epc: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  }, []);

  const handleDismiss = useCallback(async () => {
    if (selected.size === 0 || busy) return;
    const epcs = [...selected];
    const ok = window.confirm(
      `Hide ${epcs.length} EPC${epcs.length === 1 ? "" : "s"} from this list?\n\nThey'll come back if scanned again and still defective.\n\nThis does NOT change the tag's status — they stay as "${rows[0]?.status_label ?? "Tag Killed"}".`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/inventory/catalog/defective-epcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs }),
      });
      const data = (await res.json()) as { dismissed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Dismiss failed");
      setMsg(`Hid ${data.dismissed ?? 0} EPC${(data.dismissed ?? 0) === 1 ? "" : "s"} from this list.`);
      setSelected(new Set());
      void mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Dismiss failed");
    } finally {
      setBusy(false);
    }
  }, [selected, busy, rows, mutate]);

  /* Fan the selected EPCs out to every authorized handheld at the active
     location. Operator confirms once — under the hood we POST to the
     location-scoped queue (server inserts one row per handheld so each
     device's Cloud + Geiger screen surfaces the same EPCs). */
  const handleSendToHandheld = useCallback(async () => {
    if (selected.size === 0 || busy) return;
    const epcs = [...selected];
    const ok = window.confirm(
      `Send ${epcs.length} EPC${epcs.length === 1 ? "" : "s"} to every handheld at your active location?\n\nThey'll appear on each handheld's Cloud + Geiger screen.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/handhelds/epc-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        enqueued?: number;
        handhelds?: number;
        location?: { code?: string; name?: string };
        warning?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "Send failed");
      if (j.warning) {
        setMsg(j.warning);
      } else {
        const where = j.location?.code
          ? `${j.location.code}${j.location.name ? ` — ${j.location.name}` : ""}`
          : "this location";
        setMsg(
          `Sent ${epcs.length} EPC${epcs.length === 1 ? "" : "s"} to ${j.handhelds ?? 0} handheld${
            (j.handhelds ?? 0) === 1 ? "" : "s"
          } at ${where} (${j.enqueued ?? 0} queue row${(j.enqueued ?? 0) === 1 ? "" : "s"}).`,
        );
        setSelected(new Set());
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }, [selected, busy]);

  const handleExportCsv = useCallback(() => {
    const picked = rows.filter((r) => selected.has(r.epc));
    if (picked.length === 0) return;
    const header = [
      "epc",
      "system_id",
      "serial",
      "decode_reason",
      "first_scanned_at",
      "last_seen_at",
      "source",
      "source_device_label",
      "status",
    ].join(",");
    const lines = picked.map((r) =>
      [
        csvEscape(r.epc),
        csvEscape(r.system_id_padded),
        csvEscape(r.serial_raw ?? ""),
        csvEscape(r.decode_reason ?? ""),
        csvEscape(r.first_scanned_at ?? ""),
        csvEscape(r.last_seen_at ?? ""),
        csvEscape(sourceLabel(r.source)),
        csvEscape(r.source_device_label ?? ""),
        csvEscape(r.status_label),
      ].join(","),
    );
    const blob = new Blob([header + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const today = new Date().toISOString().slice(0, 10);
    a.download = `defective-epcs-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rows, selected]);

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
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              <div>
                <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
                  Defective EPC&apos;s {data ? `(${data.count}${data.capped ? "+" : ""})` : ""}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--wms-muted)]">
                  EPCs that didn&apos;t decode or whose System ID isn&apos;t in the catalog. Status stays Tag Killed unless changed manually elsewhere.
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
            <label className="flex cursor-pointer items-center gap-2 font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = !allChecked && someChecked;
                }}
                onChange={toggleAll}
                className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
              />
              Select all
            </label>
            <span className="ml-2 font-mono text-xs text-[var(--wms-muted)]">
              {selected.size > 0 ? `${selected.size} selected` : " "}
            </span>
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--wms-muted)]" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search EPC, system ID, device, status…"
                className="w-64 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] py-1.5 pl-7 pr-2 font-mono text-xs text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-[var(--wms-accent)] focus:outline-none"
                aria-label="Search defective EPCs"
              />
            </div>
            {search ? (
              <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                {displayRows.length} of {rows.length} shown
              </span>
            ) : null}
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
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || busy}
                onClick={() => void handleSendToHandheld()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--wms-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                title="Push these EPCs to every handheld at your active location (Cloud + Geiger screen)"
              >
                <Send className="h-3.5 w-3.5" />
                Send to handheld
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || busy}
                onClick={() => void handleDismiss()}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-amber-300 hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="Hide from this list (does not change status)"
              >
                <EyeOff className="h-3.5 w-3.5" />
                Dismiss
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {error ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-red-400">
                Failed to load defective EPCs.
              </div>
            ) : isLoading ? (
              <div className="px-5 py-8 text-center font-mono text-sm text-[var(--wms-muted)]">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-5 py-12 text-center font-mono text-sm text-[var(--wms-muted)]">
                No defective EPCs.
              </div>
            ) : displayRows.length === 0 ? (
              <div className="px-5 py-12 text-center font-mono text-sm text-[var(--wms-muted)]">
                No matches for &ldquo;{search}&rdquo;.
              </div>
            ) : (
              <table
                ref={tableRef}
                className="w-full min-w-[1100px] border-collapse font-mono text-xs"
                style={{ tableLayout: pickTableLayout(colWidths) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                  <tr>
                    {([
                      { label: "", noResize: true, sortKey: null as SortKey | null },
                      { label: "EPC", noResize: false, sortKey: "epc" as SortKey | null },
                      { label: "System ID", noResize: false, sortKey: "system_id" as SortKey | null },
                      { label: "First scanned", noResize: false, sortKey: "first_scanned_at" as SortKey | null },
                      { label: "Last seen", noResize: false, sortKey: "last_seen_at" as SortKey | null },
                      { label: "Age", noResize: false, sortKey: "age" as SortKey | null },
                      { label: "Source", noResize: false, sortKey: "source" as SortKey | null },
                      { label: "Device", noResize: false, sortKey: "device" as SortKey | null },
                      { label: "Status", noResize: false, sortKey: "status" as SortKey | null },
                    ]).map((c, i) => {
                      const w = colWidths[i];
                      const sortable = c.sortKey !== null;
                      const isActive = sortable && sortKey === c.sortKey;
                      return (
                        <th
                          key={c.label || `col-${i}`}
                          style={w !== null ? { width: w, minWidth: w } : undefined}
                          className="relative overflow-hidden px-3 py-2 text-left"
                          aria-sort={
                            isActive
                              ? sortDir === "asc"
                                ? "ascending"
                                : "descending"
                              : sortable
                                ? "none"
                                : undefined
                          }
                        >
                          {sortable && c.sortKey !== null ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(c.sortKey as SortKey)}
                              className={
                                "inline-flex items-center gap-1 select-none hover:text-[var(--wms-fg)] " +
                                (isActive ? "text-[var(--wms-accent)]" : "")
                              }
                              title={`Sort by ${c.label}`}
                            >
                              <span>{c.label}</span>
                              {isActive ? (
                                sortDir === "asc" ? (
                                  <ArrowUp className="h-3 w-3" />
                                ) : (
                                  <ArrowDown className="h-3 w-3" />
                                )
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-30" />
                              )}
                            </button>
                          ) : (
                            <span>{c.label}</span>
                          )}
                          {c.noResize ? null : (
                            <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((r) => {
                    const checked = selected.has(r.epc);
                    const age = ageDaysFrom(r.first_scanned_at);
                    return (
                      <tr
                        key={r.epc}
                        className={`border-b border-[var(--wms-border)]/40 ${
                          checked ? "bg-[color-mix(in_srgb,var(--wms-accent)_6%,transparent)]" : ""
                        } hover:bg-[var(--wms-surface-elevated)]/40`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleOne(r.epc)}
                            className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
                            aria-label={`Select ${r.epc}`}
                          />
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 font-semibold text-teal-400/90`} title={r.epc}>{r.epc}</td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-fg)]`}>
                          {r.decode_reason ? (
                            <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-amber-300">
                              {r.decode_reason}
                            </span>
                          ) : (
                            r.system_id_padded
                          )}
                        </td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>{formatDate(r.first_scanned_at)}</td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>{formatDate(r.last_seen_at)}</td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>{age === null ? "—" : `${age}d`}</td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={sourceLabel(r.source)}>{sourceLabel(r.source)}</td>
                        <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.source_device_label ?? ""}>{r.source_device_label ?? "—"}</td>
                        <td className="overflow-hidden px-3 py-2">
                          <span className="rounded border border-red-400/40 bg-red-400/10 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-red-300">
                            {r.status_label}
                          </span>
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
    </>
  );
}
