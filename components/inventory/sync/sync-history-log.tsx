"use client";

import useSWR from "swr";
import { memo, useState } from "react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type LogRow = {
  id: string;
  status: string;
  job_type: string;
  error: string | null;
  payload: unknown;
  created_at: string;
  updated_at: string;
};

function recordsFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "—";
  const p = payload as Record<string, unknown>;
  if (typeof p.records_updated === "number") return String(p.records_updated);
  return "—";
}

export const SyncHistoryLog = memo(function SyncHistoryLog() {
  const [page, setPage] = useState(1);
  const limit = 15;
  const { data, error, isLoading } = useSWR<{
    rows: LogRow[];
    total: number;
    page: number;
    limit: number;
  }>(`/api/inventory/sync/logs?page=${page}&limit=${limit}`, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: false,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        Sync history
      </div>
      {error ? (
        <p className="p-4 font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load logs"}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2">Timestamp</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Records</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[0.65rem] text-[var(--wms-fg)]">
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-[var(--wms-muted)]">
                  <p>No sync history found.</p>
                  <p className="mt-2 text-[0.6rem] text-[var(--wms-muted)]">
                    Trigger a manual sync and run the worker to populate jobs.
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-[var(--wms-muted)]">
                    {new Date(r.updated_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        r.status === "completed"
                          ? "text-emerald-400/90"
                          : r.status === "failed"
                            ? "text-red-400/90"
                            : "text-amber-400/90"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{recordsFromPayload(r.payload)}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-red-400/80" title={r.error ?? ""}>
                    {r.error ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {total > 0 ? (
        <div className="flex items-center justify-between border-t border-[var(--wms-border)] px-4 py-2 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          <span>
            Page {page} / {pages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-2 py-1 font-medium text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-2 py-1 font-medium text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});
