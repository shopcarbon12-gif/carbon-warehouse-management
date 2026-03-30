"use client";

import useSWR from "swr";
import type { DeviceUploadLogRow } from "@/lib/queries/device-upload-logs";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<DeviceUploadLogRow[]>;
};

export function UploadLogsWorkspace() {
  const { data, error, isLoading } = useSWR("/api/reports/upload-logs", fetcher, {
    revalidateOnFocus: true,
  });

  if (error) {
    return <p className="font-mono text-xs text-red-500/90">{String(error.message)}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
            <th className="px-3 py-3">Date</th>
            <th className="px-3 py-3">Device</th>
            <th className="px-3 py-3">Mode</th>
            <th className="px-3 py-3 text-right">CSV</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80">
          {isLoading && !data ? (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                Loading…
              </td>
            </tr>
          ) : !data?.length ? (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                No uploads yet.
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={row.id} className="text-[var(--wms-fg)]">
                <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-[var(--wms-muted)]">
                  {new Date(row.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs">{row.device_id}</td>
                <td className="px-3 py-2.5">{row.workflow_mode}</td>
                <td className="px-3 py-2.5 text-right">
                  <a
                    href={`/api/reports/upload-logs/${row.id}`}
                    className="font-mono text-xs text-[var(--wms-accent)] hover:underline"
                    download
                  >
                    Download CSV
                  </a>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
