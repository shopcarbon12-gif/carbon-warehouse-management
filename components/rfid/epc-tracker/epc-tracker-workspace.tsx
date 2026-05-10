"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Search, Radio } from "lucide-react";
import { decodeSGTIN96 } from "@/lib/epc";
import { EpcHistoryTimeline, type HistoryRow } from "./epc-history-timeline";
import type { TrackerItemDetail, TrackerSearchPickRow } from "@/lib/rfid-tracker-types";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

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

/** Per-EPC live presence — populated by Show live location while it's on. */
type LivePresence = {
  readerName: string;
  deviceId: string;
  lastSeenMs: number;
};

/** Hardware-config tree shape we care about for reader-name lookup. */
type HardwareTree = {
  locations?: {
    zones?: { readers?: { id: string; name: string }[] }[];
    unzonedReaders?: { id: string; name: string }[];
  }[];
};

function buildReaderNameMap(tree: HardwareTree | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!tree?.locations) return map;
  for (const loc of tree.locations) {
    for (const z of loc.zones ?? []) {
      for (const r of z.readers ?? []) map.set(r.id, r.name);
    }
    for (const r of loc.unzonedReaders ?? []) map.set(r.id, r.name);
  }
  return map;
}

export function EpcTrackerWorkspace() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedEpc, setSelectedEpc] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 8);

  // Show live location — purely a UI gate over the existing edge-stream SSE.
  // When ON, every read for any checked EPC stamps a "last seen by this
  // reader at this time" entry in the live presence map. Doesn't start any
  // hardware — readers are always running.
  const [live, setLive] = useState(false);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const checkedRef = useRef(checked);
  useEffect(() => {
    checkedRef.current = checked;
  }, [checked]);

  const [livePresence, setLivePresence] = useState<Map<string, LivePresence[]>>(
    new Map(),
  );
  const livePresenceRef = useRef<Map<string, LivePresence[]>>(new Map());

  // Reader-name lookup so the SSE deviceId becomes a human-readable name.
  const tree = useSWR<HardwareTree>("/api/hardware-config", fetcher, {
    refreshInterval: 0,
  });
  const readerNames = useMemo(
    () => buildReaderNameMap(tree.data),
    [tree.data],
  );
  const readerNamesRef = useRef(readerNames);
  useEffect(() => {
    readerNamesRef.current = readerNames;
  }, [readerNames]);

  // Single edge-stream subscription — accepts reads from every fixed reader
  // across every zone in the location (no ReaderPicker). On each read, if
  // live mode is on AND the EPC is checked, stamp it into livePresence.
  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!liveRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0 || !p.deviceId) return;
      const readerName =
        readerNamesRef.current.get(p.deviceId) ?? p.deviceId.slice(0, 8);
      const now = Date.now();
      let mutated = false;
      const sel = checkedRef.current;
      for (const epc of list) {
        if (!sel.has(epc)) continue;
        const existing = livePresenceRef.current.get(epc) ?? [];
        // Replace prior entry for this reader (keep one row per reader);
        // append if it's a new reader.
        const filtered = existing.filter((e) => e.deviceId !== p.deviceId);
        filtered.push({
          readerName,
          deviceId: p.deviceId,
          lastSeenMs: now,
        });
        livePresenceRef.current.set(epc, filtered);
        mutated = true;
      }
      if (mutated) setLivePresence(new Map(livePresenceRef.current));
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
    if (d.length >= 1) {
      return `/api/rfid/tracker/search?q=${encodeURIComponent(d)}`;
    }
    return null;
  }, [debounced]);

  const { data: searchJson, error: searchErr } = useSWR<SearchPayload>(
    searchUrl,
    fetcher,
    { revalidateOnFocus: false },
  );

  const pickMatches: TrackerSearchPickRow[] = useMemo(
    () =>
      searchJson?.result?.mode === "pick" ? searchJson.result.matches : [],
    [searchJson],
  );

  // Detail panel + timeline still drive off selectedEpc, populated by row
  // click. Independent of `live` and `checked`.
  const detailUrl =
    selectedEpc && isHex24(selectedEpc)
      ? `/api/rfid/tracker/search?q=${encodeURIComponent(selectedEpc)}`
      : null;
  const { data: detailJson, isLoading: detailLoading } = useSWR<SearchPayload>(
    detailUrl,
    fetcher,
    { revalidateOnFocus: false },
  );
  const item: TrackerItemDetail | null =
    detailJson?.result?.mode === "direct"
      ? detailJson.result.item
      : detailJson?.result?.mode === "pick" &&
          detailJson.result.matches.length > 0 &&
          selectedEpc &&
          isHex24(selectedEpc)
        ? null
        : null;

  // Per-EPC fallback: when search came back as "pick", the item detail
  // endpoint also returns "pick" if the EPC is unique. So fetch direct.
  const directUrl =
    selectedEpc && isHex24(selectedEpc)
      ? `/api/rfid/tracker/${encodeURIComponent(selectedEpc)}/detail`
      : null;
  void directUrl; // route doesn't exist; we resolve via pick rows instead.

  // Build TrackerItemDetail-shaped object from the pick-row when needed.
  const fallbackDetail: TrackerItemDetail | null = useMemo(() => {
    if (!selectedEpc) return null;
    const row = pickMatches.find((m) => m.epc === selectedEpc);
    if (!row) return null;
    return {
      id: "",
      epc: row.epc,
      serial_number: "",
      status: row.status,
      created_at: new Date().toISOString(),
      custom_sku_id: "",
      sku: row.sku,
      ls_system_id: row.ls_system_id,
      upc: row.upc ?? "",
      description: [row.description, row.color, row.size]
        .filter(Boolean)
        .join(" · "),
      location_id: "",
      location_code: row.location_code,
      location_name: row.location_code,
      bin_id: null,
      bin_code: row.bin_code,
      first_scanned_at: null,
      source: null,
      source_device_label: null,
      source_device_id: null,
      source_device_name: null,
      source_antenna_id: null,
      source_antenna_name: null,
      created_by_user_id: null,
      created_by_email: null,
    };
  }, [selectedEpc, pickMatches]);
  const effectiveItem = item ?? fallbackDetail;

  const historyUrl = selectedEpc
    ? `/api/rfid/tracker/${encodeURIComponent(selectedEpc)}/history?limit=100`
    : null;
  const { data: histJson, isLoading: histLoading } = useSWR<{
    history: HistoryRow[];
  }>(historyUrl, fetcher, { revalidateOnFocus: false });

  const decoded = useMemo(() => {
    if (!selectedEpc) return null;
    return decodeSGTIN96(selectedEpc);
  }, [selectedEpc]);

  const allChecked =
    pickMatches.length > 0 &&
    pickMatches.every((m) => checked.has(m.epc));
  const toggleAll = () => {
    if (allChecked) {
      const next = new Set(checked);
      for (const m of pickMatches) next.delete(m.epc);
      setChecked(next);
    } else {
      const next = new Set(checked);
      for (const m of pickMatches) next.add(m.epc);
      setChecked(next);
    }
  };
  const toggleOne = (epc: string) => {
    const next = new Set(checked);
    if (next.has(epc)) next.delete(epc);
    else next.add(epc);
    setChecked(next);
  };

  // Refreshing "now" so fmtSince's "Ns ago" updates while live. Stored in
  // state (rather than reading Date.now() during render) to satisfy React's
  // purity rule and let the renderer re-run on tick. Frozen between ticks.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const fmtSince = (ms: number): string => {
    const sec = Math.max(0, Math.floor((nowMs - ms) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  };

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="EPC (full or partial), SKU, system ID, item name, color, size, UPC, vendor, status, location, bin…"
          className="w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-3 pl-10 pr-3 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-teal-500/40 focus:outline-none focus:ring-1 focus:ring-teal-500/25"
        />
        {searchErr ? (
          <p className="mt-2 font-mono text-xs text-red-400/90">
            {searchErr instanceof Error ? searchErr.message : "Search failed"}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={() => setLive((s) => !s)}
          disabled={checked.size === 0 && !live}
          title={
            live
              ? "Stop watching readers — Last seen column freezes."
              : "Watch every fixed reader across every zone in this location for the checked EPCs. Doesn't start scanning — readers are always running anyway."
          }
          className={`inline-flex min-h-[3rem] min-w-[12rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
            live
              ? "border-emerald-500/60 bg-emerald-950/40 text-emerald-100"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
          }`}
        >
          <Radio
            className={`h-5 w-5 ${live ? "text-emerald-400" : "text-[var(--wms-muted)]"}`}
          />
          {live ? "Live · click to stop" : "Show live location"}
        </button>
        <span className="font-mono text-[10px] text-[var(--wms-muted)]">
          {checked.size > 0 ? (
            <>
              <strong className="text-[var(--wms-fg)]">{checked.size}</strong>{" "}
              checked
            </>
          ) : (
            "Check rows below to track them live"
          )}
        </span>
        {checked.size > 0 ? (
          <button
            type="button"
            onClick={() => {
              setChecked(new Set());
              livePresenceRef.current = new Map();
              setLivePresence(new Map());
            }}
            className="ml-auto rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-[var(--wms-muted)] hover:bg-[var(--wms-surface)]"
          >
            Clear checks
          </button>
        ) : null}
      </div>

      {/* Results table — one row per EPC, no grouping */}
      {pickMatches.length > 0 ? (
        <DataTableContainer maxHeight="min(70vh, 640px)">
          <table
            ref={tableRef}
            className="w-full min-w-[1100px] border-collapse text-left text-sm"
            style={{ tableLayout: pickTableLayout(colWidths) }}
          >
            <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">
              <tr>
                {[
                  { label: "", sel: true },
                  { label: "EPC" },
                  { label: "SKU" },
                  { label: "System ID" },
                  { label: "Description" },
                  { label: "Status" },
                  { label: "Loc · Bin" },
                  { label: "Last seen" },
                ].map((c, i) => {
                  const w = colWidths[i];
                  return (
                    <th
                      key={c.label || `col-${i}`}
                      style={w !== null ? { width: w, minWidth: w } : undefined}
                      className="relative overflow-hidden whitespace-nowrap px-3 py-2 text-left"
                    >
                      {c.sel ? (
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={toggleAll}
                          aria-label="Select all"
                        />
                      ) : (
                        <span>{c.label}</span>
                      )}
                      {c.sel ? null : (
                        <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pickMatches.map((m) => {
                const desc = [m.description, m.color, m.size]
                  .filter((s) => s && s.trim())
                  .join(" · ");
                const isSelected = selectedEpc === m.epc;
                const isChecked = checked.has(m.epc);
                const presence = livePresence.get(m.epc) ?? [];
                return (
                  <tr
                    key={m.epc}
                    className={`cursor-pointer border-t border-[var(--wms-border)] hover:bg-[var(--wms-surface-elevated)] ${
                      isSelected
                        ? "bg-[color-mix(in_srgb,var(--wms-accent)_12%,var(--wms-surface-elevated))]"
                        : ""
                    }`}
                    onClick={() => setSelectedEpc(m.epc)}
                  >
                    <td
                      className="whitespace-nowrap px-3 py-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleOne(m.epc)}
                        aria-label={`Select ${m.epc}`}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-teal-400/90">
                      {m.epc}
                      {m.archived ? (
                        <span className="ml-1.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 align-middle text-[9px] font-bold uppercase tracking-wider text-amber-300">
                          Archived
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {m.sku}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {m.ls_system_id}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                      {desc || <span className="text-[var(--wms-muted)]">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white ${
                          m.status === "in-stock"
                            ? "bg-emerald-600"
                            : m.status === "tag_killed"
                              ? "bg-red-600"
                              : "bg-slate-500"
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {m.location_code}
                      {m.bin_code ? ` · ${m.bin_code}` : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {presence.length === 0 ? (
                        <span className="text-[var(--wms-muted)]">
                          {live && isChecked ? "watching…" : "—"}
                        </span>
                      ) : (
                        presence.map((p) => (
                          <div key={p.deviceId} className="leading-tight">
                            <span className="text-emerald-400">{p.readerName}</span>
                            <span className="text-[var(--wms-muted)]"> · </span>
                            <span title={new Date(p.lastSeenMs).toLocaleString()}>
                              {fmtSince(p.lastSeenMs)}
                            </span>
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTableContainer>
      ) : debounced.length >= 1 ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">
          No items match this query.
        </p>
      ) : null}

      {/* Detail panels — render whenever a row is selected (regardless of
          live state); status + decoded layout side-by-side. */}
      {selectedEpc && effectiveItem ? (
        <div className="grid gap-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4 lg:grid-cols-2">
          <div>
            <h3 className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
              Tag status
            </h3>
            <dl className="mt-3 space-y-2 font-mono text-xs text-[var(--wms-fg)]">
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">EPC</dt>
                <dd className="break-all text-right text-teal-400/90">
                  {effectiveItem.epc}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Status</dt>
                <dd className="text-right font-medium">{effectiveItem.status}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Location / bin</dt>
                <dd className="text-right">
                  {effectiveItem.location_code} / {effectiveItem.bin_code ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Recorded</dt>
                <dd className="text-right text-[var(--wms-muted)]">
                  {new Date(effectiveItem.created_at).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">SKU</dt>
                <dd className="text-right">{effectiveItem.sku}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">System ID / UPC</dt>
                <dd className="text-right">
                  {effectiveItem.ls_system_id} · {effectiveItem.upc || "—"}
                </dd>
              </div>
              {/* Provenance: where this EPC came from to the system. */}
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Entered system</dt>
                <dd className="text-right text-[var(--wms-muted)]">
                  {effectiveItem.first_scanned_at
                    ? new Date(effectiveItem.first_scanned_at).toLocaleString()
                    : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Source</dt>
                <dd className="text-right">{effectiveItem.source ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Source device</dt>
                <dd className="break-all text-right">
                  {effectiveItem.source_device_name ??
                    effectiveItem.source_device_label ??
                    "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-b border-[var(--wms-border)]/80 py-1">
                <dt className="text-[var(--wms-muted)]">Source antenna</dt>
                <dd className="text-right">
                  {effectiveItem.source_antenna_name ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2 py-1">
                <dt className="text-[var(--wms-muted)]">Added by</dt>
                <dd className="break-all text-right">
                  {effectiveItem.created_by_email ?? "—"}
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
              {effectiveItem.description}
            </p>
          </div>
        </div>
      ) : selectedEpc && detailLoading ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">
          Loading tag details…
        </p>
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
