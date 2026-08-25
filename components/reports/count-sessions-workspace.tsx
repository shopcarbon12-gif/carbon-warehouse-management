"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Download } from "lucide-react";
import type { CountSessionReportRow } from "@/lib/queries/inventory-reports";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

const PAGE_SIZE = 25;

type ListResponse = {
  rows: CountSessionReportRow[];
  total: number;
  page: number;
  limit: number;
};

const fetcher = async (url: string): Promise<ListResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<ListResponse>;
};

const activitiesFetcher = async (url: string): Promise<string[]> => {
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json() as Promise<string[]>;
};

function buildUrl(opts: {
  page: number;
  activity: string;
  search: string;
  from: string;
  to: string;
}): string {
  const p = new URLSearchParams({
    page: String(opts.page),
    limit: String(PAGE_SIZE),
  });
  if (opts.activity) p.set("activity", opts.activity);
  if (opts.search.trim()) p.set("search", opts.search.trim());
  if (opts.from) p.set("from", opts.from);
  if (opts.to) p.set("to", opts.to);
  return `/api/reports/count-sessions?${p}`;
}

export function CountSessionsWorkspace() {
  const [page, setPage] = useState(1);
  const [activity, setActivity] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 320);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced, activity, from, to]);

  const url = useMemo(
    () => buildUrl({ page, activity, search: debounced, from, to }),
    [page, activity, debounced, from, to],
  );
  const { data, error, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus: false,
  });

  const { data: activityList } = useSWR(
    "/api/reports/count-sessions/activities",
    activitiesFetcher,
    { revalidateOnFocus: false },
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 font-mono text-[0.6rem] max-md:text-xs max-md:w-full uppercase tracking-wide text-[var(--wms-muted)]">
          <span>Search filename</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. COUNT_20260424"
            className="w-64 max-md:w-full max-md:text-base max-md:min-h-11 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)]"
          />
        </label>
        <label className="grid gap-1 font-mono text-[0.6rem] max-md:text-xs max-md:w-full uppercase tracking-wide text-[var(--wms-muted)]">
          <span>Activity</span>
          <select
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            className="w-44 max-md:w-full max-md:text-base max-md:min-h-11 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
          >
            <option value="">All</option>
            {(activityList ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 font-mono text-[0.6rem] max-md:text-xs max-md:w-full uppercase tracking-wide text-[var(--wms-muted)]">
          <span>From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="max-md:w-full max-md:text-base max-md:min-h-11 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
          />
        </label>
        <label className="grid gap-1 font-mono text-[0.6rem] max-md:text-xs max-md:w-full uppercase tracking-wide text-[var(--wms-muted)]">
          <span>To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="max-md:w-full max-md:text-base max-md:min-h-11 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
          />
        </label>
        {(activity || search || from || to) ? (
          <button
            type="button"
            onClick={() => {
              setActivity("");
              setSearch("");
              setFrom("");
              setTo("");
            }}
            className="max-md:w-full max-md:min-h-11 rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))]"
          >
            Clear
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}

      <CountSessionsTable rows={rows} isLoading={isLoading} hasData={!!data} />


      {total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[0.65rem] max-md:text-xs text-[var(--wms-muted)]">
          <span>
            {total} report{total === 1 ? "" : "s"} · page {page} / {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="max-md:py-2 max-md:min-h-11 rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-1 font-medium text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="max-md:py-2 max-md:min-h-11 rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-1 font-medium text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}


function CountSessionsTable({
  rows,
  isLoading,
  hasData,
}: {
  rows: CountSessionReportRow[];
  isLoading: boolean;
  hasData: boolean;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 8);
  const cols: { label: string; align?: "right"; mobileCls?: string }[] = [
    { label: "Uploaded at" },
    { label: "Activity" },
    { label: "Uploaded by" },
    { label: "Device", mobileCls: "max-md:hidden" },
    { label: "Rows", align: "right" },
    { label: "Filename", mobileCls: "max-md:hidden" },
    { label: "Expires", mobileCls: "max-md:hidden" },
    {
      label: "CSV",
      align: "right",
      mobileCls:
        "max-md:sticky max-md:right-0 max-md:z-[11] max-md:bg-[var(--wms-surface-elevated)] max-md:shadow-[inset_2px_0_0_var(--wms-border)]",
    },
  ];
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[900px] max-md:min-w-[480px] border-collapse text-left text-sm"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] max-md:text-xs uppercase text-[var(--wms-muted)]">
          <tr className="border-b border-[var(--wms-border)]">
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-3 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.mobileCls ?? ""}`}
                >
                  <span>{c.label}</span>
                  <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80">
          {isLoading && !hasData ? (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                Loading…
              </td>
            </tr>
          ) : !rows.length ? (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                No reports match these filters.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="text-[var(--wms-fg)]">
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]`}>
                  {new Date(row.uploaded_at).toLocaleString()}
                </td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs`} title={row.activity}>{row.activity}</td>
                <td className={`${cellTruncate} px-3 py-2.5 font-mono text-xs text-[var(--wms-muted)]`} title={row.uploaded_by ?? ""}>
                  {row.uploaded_by ?? "—"}
                </td>
                <td className={`${cellTruncate} max-md:hidden px-3 py-2.5 font-mono text-xs text-[var(--wms-muted)]`} title={row.device_id ?? ""}>
                  {row.device_id ?? "—"}
                </td>
                <td className="overflow-hidden px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                  {row.row_count}
                </td>
                <td className={`${cellTruncate} max-md:hidden px-3 py-2.5 font-mono text-xs`} title={row.filename}>{row.filename}</td>
                <td className={`${cellTruncate} max-md:hidden px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]`}>
                  {new Date(row.expires_at).toLocaleDateString()}
                </td>
                <td className="overflow-hidden px-3 py-2.5 text-right max-md:sticky max-md:right-0 max-md:z-[5] max-md:bg-[var(--wms-surface)] max-md:shadow-[inset_2px_0_0_var(--wms-border)]">
                  <a
                    href={`/api/reports/count-sessions/${row.id}/download`}
                    className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-2 py-1 font-mono text-[0.6rem] max-md:text-xs max-md:min-h-11 max-md:px-3 font-medium text-[var(--wms-accent)] hover:opacity-90"
                  >
                    <Download className="h-3 w-3 max-md:h-4 max-md:w-4" />
                    Download
                  </a>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
