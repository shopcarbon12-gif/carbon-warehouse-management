"use client";

import useSWR from "swr";
import type { AuditLogListRow } from "@/lib/queries/dashboard-command";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<AuditLogListRow[]>;
};

function formatLine(row: AuditLogListRow): string {
  const bits: string[] = [row.action, row.entity].filter(Boolean);
  if (row.metadata && typeof row.metadata === "object" && row.metadata !== null) {
    const m = row.metadata as Record<string, unknown>;
    const summary = m.summary ?? m.detail ?? m.label;
    if (typeof summary === "string" && summary.length < 120) {
      bits.push(`— ${summary}`);
    }
  }
  return bits.join(" · ");
}

export function ActivityHistoryWorkspace() {
  const { data, error, isLoading } = useSWR("/api/reports/audit?limit=200", fetcher, {
    revalidateOnFocus: true,
  });

  if (error) {
    return <p className="font-mono text-xs text-red-500/90">{String(error.message)}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
            <th className="px-3 py-3">When</th>
            <th className="px-3 py-3">Event</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80">
          {isLoading && !data ? (
            <tr>
              <td colSpan={2} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                Loading…
              </td>
            </tr>
          ) : !data?.length ? (
            <tr>
              <td colSpan={2} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                No audit rows.
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[0.65rem] tabular-nums text-[var(--wms-muted)]">
                  {new Date(row.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs leading-snug text-[var(--wms-fg)]">
                  {formatLine(row)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
