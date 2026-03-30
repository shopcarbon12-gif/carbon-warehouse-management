"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Search } from "lucide-react";
import { decodeSGTIN96 } from "@/lib/epc";
import { EpcHistoryTimeline, type HistoryRow } from "./epc-history-timeline";
import type { TrackerItemDetail, TrackerSearchPickRow } from "@/lib/rfid-tracker-types";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

function isHex24(s: string): boolean {
  return /^[0-9A-Fa-f]{24}$/.test(s.trim());
}

type SearchPayload = {
  result:
    | { mode: "direct"; item: TrackerItemDetail }
    | { mode: "pick"; matches: TrackerSearchPickRow[] };
};

export function EpcTrackerWorkspace() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedEpc, setSelectedEpc] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 320);
    return () => window.clearTimeout(t);
  }, [q]);

  const searchUrl = useMemo(() => {
    const d = debounced;
    if (!d) return null;
    if (isHex24(d) || d.length >= 2) {
      return `/api/rfid/tracker/search?q=${encodeURIComponent(d)}`;
    }
    return null;
  }, [debounced]);

  const { data: searchJson, error: searchErr } = useSWR<SearchPayload>(
    searchUrl,
    fetcher,
    { revalidateOnFocus: false },
  );

  const searchResult = searchJson?.result;

  const directEpc = searchResult?.mode === "direct" ? searchResult.item.epc : null;
  const focusedEpc =
      selectedEpc ?? (directEpc && isHex24(directEpc) ? directEpc : null);

  const detailUrl =
    focusedEpc && isHex24(focusedEpc)
      ? `/api/rfid/tracker/search?q=${encodeURIComponent(focusedEpc)}`
      : null;

  const {
    data: detailJson,
    error: detailErr,
    isLoading: detailLoading,
  } = useSWR<SearchPayload>(detailUrl, fetcher, {
    revalidateOnFocus: false,
  });

  const item: TrackerItemDetail | null =
    detailJson?.result?.mode === "direct" ? detailJson.result.item : null;

  const detailMissing =
    focusedEpc &&
    !detailLoading &&
    detailJson?.result?.mode === "pick" &&
    (detailJson.result.matches?.length ?? 0) === 0;

  const historyUrl = focusedEpc
    ? `/api/rfid/tracker/${encodeURIComponent(focusedEpc)}/history?limit=100`
    : null;

  const { data: histJson, isLoading: histLoading } = useSWR<{ history: HistoryRow[] }>(
    historyUrl,
    fetcher,
    { revalidateOnFocus: false },
  );

  const decoded = useMemo(() => {
    if (!focusedEpc) return null;
    return decodeSGTIN96(focusedEpc);
  }, [focusedEpc]);

  const pickMatches =
    searchResult?.mode === "pick" ? searchResult.matches : [];

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="24-char hex EPC, SKU, or Lightspeed System ID…"
          className="w-full rounded-lg border border-slate-700 bg-zinc-900 py-3 pl-10 pr-3 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal-500/40 focus:outline-none focus:ring-1 focus:ring-teal-500/25"
        />
        {searchErr ? (
          <p className="mt-2 font-mono text-xs text-red-400/90">
            {searchErr instanceof Error ? searchErr.message : "Search failed"}
          </p>
        ) : null}
      </div>

      {pickMatches.length > 0 ? (
        <div className="rounded-lg border border-slate-800 bg-zinc-950/80 p-4">
          <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
            Select tag ({pickMatches.length})
          </h3>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {pickMatches.map((m) => (
              <li key={m.epc}>
                <button
                  type="button"
                  onClick={() => setSelectedEpc(m.epc)}
                  className={`w-full rounded-md px-3 py-2 text-left font-mono text-xs hover:bg-zinc-800 ${
                    focusedEpc === m.epc ? "bg-teal-950/40 text-teal-200" : "text-slate-300"
                  }`}
                >
                  <span className="text-teal-400/90">{m.epc}</span>
                  <span className="text-slate-600"> · </span>
                  {m.sku}
                  <span className="block text-[0.6rem] text-slate-500">
                    {m.location_code}
                    {m.bin_code ? ` / ${m.bin_code}` : ""} · {m.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {searchResult?.mode === "pick" && pickMatches.length === 0 && debounced.length >= 2 ? (
        <p className="font-mono text-xs text-slate-600">No items match this query.</p>
      ) : null}

      {detailErr ? (
        <p className="font-mono text-xs text-red-400/90">
          {detailErr instanceof Error ? detailErr.message : "Detail fetch failed"}
        </p>
      ) : null}

      {detailMissing ? (
        <p className="font-mono text-xs text-amber-500/90">
          No item row for EPC <span className="text-teal-400/80">{focusedEpc}</span>.
        </p>
      ) : null}

      {focusedEpc && item ? (
        <div className="grid gap-4 rounded-lg border border-slate-800 bg-zinc-950/80 p-4 lg:grid-cols-2">
          <div>
            <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
              Tag status
            </h3>
            <dl className="mt-3 space-y-2 font-mono text-xs text-slate-300">
              <div className="flex justify-between gap-2 border-b border-slate-800/80 py-1">
                <dt className="text-slate-500">EPC</dt>
                <dd className="break-all text-right text-teal-400/90">{item.epc}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-800/80 py-1">
                <dt className="text-slate-500">Status</dt>
                <dd className="text-right font-medium text-slate-100">{item.status}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-800/80 py-1">
                <dt className="text-slate-500">Location / bin</dt>
                <dd className="text-right">
                  {item.location_code} / {item.bin_code ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-800/80 py-1">
                <dt className="text-slate-500">Recorded</dt>
                <dd className="text-right text-slate-400">
                  {new Date(item.created_at).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-800/80 py-1">
                <dt className="text-slate-500">SKU</dt>
                <dd className="text-right">{item.sku}</dd>
              </div>
              <div className="flex justify-between gap-2 py-1">
                <dt className="text-slate-500">System ID / UPC</dt>
                <dd className="text-right">
                  {item.ls_system_id} · {item.upc}
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
              Decoded SGTIN-96 (WMS 96-bit layout)
            </h3>
            {decoded ? (
              <dl className="mt-3 space-y-2 font-mono text-xs text-slate-300">
                <div className="flex justify-between border-b border-slate-800/80 py-1">
                  <dt className="text-slate-500">Company prefix (20 bit)</dt>
                  <dd>{decoded.companyPrefix}</dd>
                </div>
                <div className="flex justify-between border-b border-slate-800/80 py-1">
                  <dt className="text-slate-500">Item ref (40 bit)</dt>
                  <dd>{decoded.itemReference}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-slate-500">Serial (36 bit)</dt>
                  <dd>{decoded.serialNumber}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 font-mono text-xs text-amber-500/90">
                EPC is not 24 hex — decode unavailable.
              </p>
            )}
            <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-slate-600">
              {item.description}
            </p>
          </div>
        </div>
      ) : selectedEpc && detailLoading ? (
        <p className="font-mono text-xs text-slate-500">Loading tag details…</p>
      ) : null}

      {selectedEpc ? (
        <div className="rounded-lg border border-slate-800 bg-zinc-950/80 p-4">
          <h3 className="mb-4 font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
            Audit timeline
          </h3>
          <EpcHistoryTimeline rows={histJson?.history ?? []} loading={histLoading} />
        </div>
      ) : null}
    </div>
  );
}
