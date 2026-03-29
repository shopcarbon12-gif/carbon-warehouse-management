"use client";

import { useCallback, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

type SyncCompareRow = {
  sku: string;
  description: string;
  lsCount: number;
  physicalCount: number;
  variance: number;
};

type SyncComparePayload = {
  lsLocationId: string;
  over: SyncCompareRow[];
  short: SyncCompareRow[];
  matched: SyncCompareRow[];
};

type RowKind = "over" | "short" | "matched";

function varianceClass(kind: RowKind): string {
  switch (kind) {
    case "short":
      return "text-red-400";
    case "over":
      return "text-blue-400";
    case "matched":
    default:
      return "text-emerald-400";
  }
}

export function SyncEngine() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SyncComparePayload | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/compare");
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setData((await res.json()) as SyncComparePayload);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Comparison failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const tableRows = useMemo(() => {
    if (!data) return [];
    const out: { kind: RowKind; row: SyncCompareRow }[] = [
      ...data.short.map((row) => ({ kind: "short" as const, row })),
      ...data.over.map((row) => ({ kind: "over" as const, row })),
      ...data.matched.map((row) => ({ kind: "matched" as const, row })),
    ];
    out.sort((a, b) => a.row.sku.localeCompare(b.row.sku));
    return out;
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-mono text-[0.65rem] uppercase tracking-wider text-slate-500">
            Lightspeed ↔ RFID
          </p>
          {data ? (
            <p className="mt-1 font-mono text-xs text-slate-500">
              LS location key:{" "}
              <span className="text-teal-500/90">{data.lsLocationId}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void run()}
            className="inline-flex min-h-11 min-w-[200px] items-center justify-center gap-2 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-sm hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
            ) : (
              <RefreshCw className="h-5 w-5" strokeWidth={2} />
            )}
            Run comparison
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-700 bg-zinc-900 px-4 py-2.5 text-sm font-medium text-slate-500"
          >
            Push to Lightspeed
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 font-mono text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-zinc-900/80 px-4 py-4">
              <p className="font-mono text-[0.65rem] uppercase tracking-wider text-slate-500">
                Over
              </p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-blue-400">
                {data.over.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Physical &gt; LS qty</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-zinc-900/80 px-4 py-4">
              <p className="font-mono text-[0.65rem] uppercase tracking-wider text-slate-500">
                Short
              </p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-red-400">
                {data.short.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Physical &lt; LS qty</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-zinc-900/80 px-4 py-4">
              <p className="font-mono text-[0.65rem] uppercase tracking-wider text-slate-500">
                Matched
              </p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-emerald-400">
                {data.matched.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Counts aligned</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[800px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.65rem] uppercase tracking-wider text-slate-400">
                  <th className="px-3 py-2.5">Custom SKU</th>
                  <th className="px-3 py-2.5">Description</th>
                  <th className="px-3 py-2.5 text-right">LS count</th>
                  <th className="px-3 py-2.5 text-right">Physical</th>
                  <th className="px-3 py-2.5 text-right">Variance</th>
                  <th className="px-3 py-2.5">Bucket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-zinc-950">
                {tableRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center font-mono text-xs text-slate-500"
                    >
                      No custom SKUs to compare — add matrix data or mock LS lines.
                    </td>
                  </tr>
                ) : (
                  tableRows.map(({ kind, row }) => (
                    <tr key={row.sku} className="text-slate-200">
                      <td className="px-3 py-1.5 font-mono text-xs text-teal-400/90">
                        {row.sku}
                      </td>
                      <td className="max-w-xs truncate px-3 py-1.5 text-xs text-slate-300">
                        {row.description}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-slate-400">
                        {row.lsCount}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-slate-300">
                        {row.physicalCount}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono text-xs font-medium tabular-nums ${varianceClass(kind)}`}
                      >
                        {row.variance > 0 ? `+${row.variance}` : String(row.variance)}
                      </td>
                      <td className={`px-3 py-1.5 text-xs font-medium ${varianceClass(kind)}`}>
                        {kind === "over"
                          ? "Over"
                          : kind === "short"
                            ? "Short"
                            : "Matched"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : !loading && !error ? (
        <p className="font-mono text-sm text-slate-500">
          Run a comparison to load Lightspeed mock inventory vs in-stock EPC counts.
        </p>
      ) : null}
    </div>
  );
}
