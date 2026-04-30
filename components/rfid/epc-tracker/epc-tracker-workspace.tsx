"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Search, Radio, ScanLine } from "lucide-react";
import { decodeSGTIN96 } from "@/lib/epc";
import { EpcHistoryTimeline, type HistoryRow } from "./epc-history-timeline";
import type { TrackerItemDetail, TrackerSearchPickRow } from "@/lib/rfid-tracker-types";
import { ReaderPicker } from "@/components/shared/reader-picker";

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

  // Scan controls — same pattern as the other pages. A scanned EPC drops the
  // operator into the matching tracker page automatically.
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(scanning);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(() => new Set());
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!scanningRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      const first = list[0];
      if (first) {
        setQ(first);
        setSelectedEpc(first);
      }
    };
    return () => es.close();
  }, []);

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
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="24-char hex EPC, SKU, or Lightspeed System ID…"
          className="w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-3 pl-10 pr-3 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-teal-500/40 focus:outline-none focus:ring-1 focus:ring-teal-500/25"
        />
        {searchErr ? (
          <p className="mt-2 font-mono text-xs text-red-400/90">
            {searchErr instanceof Error ? searchErr.message : "Search failed"}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={() => setScanning((s) => !s)}
          className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors ${
            scanning
              ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
          }`}
        >
          <Radio
            className={`h-5 w-5 ${
              scanning ? "text-amber-400" : "text-[var(--wms-muted)]"
            }`}
          />
          {scanning ? "Scanning… (click to pause)" : "Start scan"}
        </button>
        <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} />
        <button
          type="button"
          disabled={q.length === 0 && selectedEpc === null}
          onClick={() => {
            setQ("");
            setSelectedEpc(null);
            setScanning(false);
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
        >
          <ScanLine className="h-4 w-4" />
          Clear staged
        </button>
      </div>

      {pickMatches.length > 0 ? (
        <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
          <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
            Select tag ({pickMatches.length})
          </h3>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {pickMatches.map((m) => (
              <li key={m.epc}>
                <button
                  type="button"
                  onClick={() => setSelectedEpc(m.epc)}
                  className={`w-full rounded-md px-3 py-2 text-left font-mono text-xs hover:bg-[var(--wms-surface-elevated)] ${
                    focusedEpc === m.epc
                      ? "bg-[color-mix(in_srgb,var(--wms-accent)_20%,var(--wms-surface-elevated))] font-semibold text-[var(--wms-fg)] ring-1 ring-[color-mix(in_srgb,var(--wms-accent)_45%,var(--wms-border))] dark:bg-teal-950/45 dark:text-teal-100 dark:ring-teal-700/40"
                      : "text-[var(--wms-fg)]"
                  }`}
                >
                  <span className="text-teal-400/90">{m.epc}</span>
                  <span className="text-[var(--wms-muted)]"> · </span>
                  {m.sku}
                  <span className="block text-[0.6rem] text-[var(--wms-muted)]">
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
        <p className="font-mono text-xs text-[var(--wms-muted)]">No items match this query.</p>
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
        <div className="grid gap-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4 lg:grid-cols-2">
          <div>
            <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
              Tag status
            </h3>
            <dl className="mt-3 space-y-2 font-mono text-xs text-[var(--wms-fg)]">
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">EPC</dt>
                <dd className="break-all text-right text-teal-400/90">{item.epc}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Status</dt>
                <dd className="text-right font-medium text-[var(--wms-fg)]">{item.status}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Location / bin</dt>
                <dd className="text-right">
                  {item.location_code} / {item.bin_code ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Recorded</dt>
                <dd className="text-right text-[var(--wms-muted)]">
                  {new Date(item.created_at).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">SKU</dt>
                <dd className="text-right">{item.sku}</dd>
              </div>
              <div className="flex justify-between gap-2 py-1">
                <dt className="text-[var(--wms-muted)]">System ID / UPC</dt>
                <dd className="text-right">
                  {item.ls_system_id} · {item.upc}
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
              Decoded SGTIN-96 (WMS 96-bit layout)
            </h3>
            {decoded ? (
              <dl className="mt-3 space-y-2 font-mono text-xs text-[var(--wms-fg)]">
                <div className="flex justify-between border-b border-[var(--wms-border)]/80 py-1">
                  <dt className="text-[var(--wms-muted)]">Company prefix (20 bit)</dt>
                  <dd>{decoded.companyPrefix}</dd>
                </div>
                <div className="flex justify-between border-b border-[var(--wms-border)]/80 py-1">
                  <dt className="text-[var(--wms-muted)]">Item ref (40 bit)</dt>
                  <dd>{decoded.itemReference}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-[var(--wms-muted)]">Serial (36 bit)</dt>
                  <dd>{decoded.serialNumber}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 font-mono text-xs text-amber-500/90">
                EPC is not 24 hex — decode unavailable.
              </p>
            )}
            <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
              {item.description}
            </p>
          </div>
        </div>
      ) : selectedEpc && detailLoading ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">Loading tag details…</p>
      ) : null}

      {selectedEpc ? (
        <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
          <h3 className="mb-4 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
            Audit timeline
          </h3>
          <EpcHistoryTimeline rows={histJson?.history ?? []} loading={histLoading} />
        </div>
      ) : null}
    </div>
  );
}
