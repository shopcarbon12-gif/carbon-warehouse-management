"use client";

import { useCallback, useState } from "react";

type SaleRow = {
  saleID: string;
  timeStamp: string;
  calcTotal: string;
  completed: string;
  voided: string;
  referenceNumber: string;
  shopID: string;
  customerID: string;
};

type ApiOk = {
  ok: true;
  limit: number;
  offset: number;
  totalCount: number;
  sales: SaleRow[];
};

export function LightspeedSalesWorkspace() {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const u = new URL("/api/lightspeed/sales", window.location.origin);
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("offset", String(nextOffset));
      const res = await fetch(u.toString());
      const j = (await res.json()) as ApiOk | { error?: string };
      if (!res.ok) {
        throw new Error((j as { error?: string }).error ?? res.statusText);
      }
      const ok = j as ApiOk;
      setRows(ok.sales);
      setTotalCount(ok.totalCount);
      setOffset(nextOffset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setRows([]);
      setTotalCount(null);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(0)}
          className="rounded-lg border border-violet-600/45 bg-violet-950/25 px-4 py-2 font-mono text-xs text-violet-200 hover:bg-violet-900/20 disabled:opacity-40"
        >
          {loading ? "Loading…" : "Load recent sales"}
        </button>
        <button
          type="button"
          disabled={loading || offset < limit}
          onClick={() => void load(Math.max(0, offset - limit))}
          className="rounded-md border border-[var(--wms-border)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/80 disabled:opacity-40"
        >
          Previous page
        </button>
        <button
          type="button"
          disabled={
            loading ||
            rows.length < limit ||
            (totalCount != null && offset + limit >= totalCount)
          }
          onClick={() => void load(offset + limit)}
          className="rounded-md border border-[var(--wms-border)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/80 disabled:opacity-40"
        >
          Next page
        </button>
        {totalCount != null ? (
          <span className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
            offset {offset} · reported total {totalCount}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 font-mono text-xs text-amber-200">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-xs uppercase text-[var(--wms-muted)]">
              <th className="px-3 py-2">Sale ID</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Done</th>
              <th className="px-3 py-2">Void</th>
              <th className="px-3 py-2">Reference</th>
              <th className="px-3 py-2">Shop</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  No rows — load sales (R-Series API, admin only).
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.saleID || r.referenceNumber} className="border-b border-[var(--wms-border)]/60">
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-fg)]">{r.saleID || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">{r.timeStamp || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-fg)]">{r.calcTotal || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">{r.completed || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">{r.voided || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">{r.referenceNumber || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">{r.shopID || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
