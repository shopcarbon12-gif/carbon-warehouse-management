"use client";

import { useState } from "react";
import useSWR from "swr";
import { Download, Search } from "lucide-react";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";
import { statusClass, statusLabel } from "@/components/rfid/ship-scan-out/ship-scan-out-workspace";

type Row = {
  id: string;
  at: string;
  user: string;
  action: string;
  epc: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  sku: string | null;
  upc: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
  orderName: string | null;
  reader: string | null;
  rssi: number | null;
  detail: string | null;
};

const ACTION: Record<string, [string, string]> = {
  scan_out: ["Scanned out", "text-emerald-600 dark:text-emerald-300"],
  rejected: ["Refused", "text-red-600 dark:text-red-300"],
  undo: ["Undone", "text-amber-600 dark:text-amber-300"],
  reader_start: ["Reader started", "text-[var(--wms-muted)]"],
  reader_stop: ["Reader stopped", "text-[var(--wms-muted)]"],
};

const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText);
  return r.json() as Promise<{ rows: Row[] }>;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit", hour: "numeric", minute: "2-digit", second: "2-digit" });

export function ScanOutLogWorkspace() {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 300);
  const { data, error, isLoading } = useSWR(`/api/reports/scan-out?q=${encodeURIComponent(dq)}`, fetcher, { refreshInterval: 30_000 });
  const rows = data?.rows ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]" />
          <input
            id="scan-out-log-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search EPC, SKU, UPC, item, order or user"
            className="w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-bg)] py-2 pl-8 pr-3 text-sm text-[var(--wms-fg)] max-md:min-h-11"
          />
        </div>
        <a
          href={`/api/reports/scan-out?format=csv&q=${encodeURIComponent(dq)}`}
          className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11"
        >
          <Download className="h-4 w-4" /> Export CSV
        </a>
      </div>

      {error ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{String(error.message ?? error)}</p> : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
        <table className="w-full min-w-[1200px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] text-xs text-[var(--wms-muted)]">
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">SKU / UPC</th>
              <th className="px-3 py-2">Bin</th>
              <th className="px-3 py-2">EPC</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Signal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [label, cls] = ACTION[r.action] ?? [r.action, ""];
              return (
                <tr key={r.id} className="border-b border-[var(--wms-border)]/50 align-top">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[var(--wms-fg)]/85">{when(r.at)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[var(--wms-fg)]">{r.user}</td>
                  <td className={`whitespace-nowrap px-3 py-2 font-medium ${cls}`}>
                    {label}
                    {r.detail ? <div className="max-w-56 whitespace-normal text-xs font-normal text-[var(--wms-muted)]">{r.detail}</div> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[var(--wms-fg)]">{r.orderName ?? ""}</td>
                  <td className="px-3 py-2 text-[var(--wms-fg)]">
                    {r.name ?? ""}
                    {r.color || r.size ? (
                      <div className="text-xs text-[var(--wms-muted)]">{[r.color, r.size && `Size ${r.size}`].filter(Boolean).join(" · ")}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-fg)]/85">
                    {r.sku ?? ""}
                    {r.upc ? <div className="text-[var(--wms-muted)]">{r.upc}</div> : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-fg)]/85">{r.bin ?? ""}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-fg)]/85">{r.epc ?? (r.reader ? `reader ${r.reader}` : "")}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.epc ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <span className={`rounded-md border px-1.5 py-0.5 font-mono font-semibold ${statusClass(r.oldStatus)}`}>{statusLabel(r.oldStatus)}</span>
                        {r.newStatus ? (
                          <>
                            →<span className={`rounded-md border px-1.5 py-0.5 font-mono font-semibold ${statusClass(r.newStatus)}`}>{statusLabel(r.newStatus)}</span>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">{r.rssi != null ? `${r.rssi} dBm` : ""}</td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-[var(--wms-muted)]">
                  {isLoading ? "Loading…" : q ? "Nothing matches this search." : "Nothing has been scanned out yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
