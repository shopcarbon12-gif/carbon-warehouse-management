"use client";

/**
 * Bulk Import workspace — read tags that have NEVER been in the system
 * at this location and commit them to inventory as LIVE.
 *
 * Three controls above a sortable table:
 *   - Start scanning button (toggles to Stop) — wakes the picked reader
 *     via /api/scan-sessions/start (kind="bulk-import"), subscribes to
 *     /api/edge/stream. Batches incoming EPCs and ships them to
 *     /api/inventory/bulk-import/scan which decodes, filters out
 *     anything already in items at THIS location, returns enriched
 *     rows (custom_sku, name, color, size, etc).
 *   - Clear list button — wipes the local state but does NOT touch the
 *     server. Reader state is independent.
 *   - Add to inventory button — POSTs selected EPCs to
 *     /api/inventory/bulk-import/commit which INSERTs items rows at
 *     this location with status='in-stock'. After commit those EPCs
 *     are in the system and the scan endpoint will filter them out
 *     forever (per spec: "those EPCs will never be able to rescan
 *     again in this module").
 *
 * Default reader: .16 (Transfer Bin). Operator can swap via the picker.
 *
 * Table is grouped by SKU (one row per custom_sku_id) — Qty cell shows
 * count of EPCs for that SKU, RFID column has an EPC button that opens
 * a modal listing the EPCs with a trash icon per-row for local removal.
 *
 * Every data header is a click-to-sort button (asc→desc→asc), with
 * faded ⇅ on inactive sortable headers and ↑/↓ on the active one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Play,
  PackagePlus,
  Radio,
  Square,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { ReaderPicker } from "@/components/shared/reader-picker";

const DEFAULT_READER_IP = "192.168.1.16";

type HardwareConfigZone = {
  readers?: Array<{ id: string; network_address: string | null }>;
};
type HardwareConfigLocation = {
  zones?: HardwareConfigZone[];
  unzoned_readers?: Array<{ id: string; network_address: string | null }>;
};
type HardwareConfigTree = {
  locations?: HardwareConfigLocation[];
};
const hcFetcher = async (url: string): Promise<HardwareConfigTree> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("hardware-config fetch failed");
  return r.json() as Promise<HardwareConfigTree>;
};

type EnrichedRow = {
  epc: string;
  custom_sku_id: string;
  sku: string;
  upc: string | null;
  name: string;
  size: string | null;
  color: string | null;
  system_id: string;
};

type GroupedRow = {
  custom_sku_id: string;
  sku: string;
  upc: string | null;
  name: string;
  size: string | null;
  color: string | null;
  // Map<epc, EnrichedRow> so removals are O(1) and dedup is free.
  epcs: Map<string, EnrichedRow>;
};

type SortKey = "sku" | "upc" | "name" | "color" | "size" | "qty";

export function BulkImportWorkspace() {
  // --- Reader picker + default to .16 ---------------------------------
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(new Set());
  const { data: hcData } = useSWR<HardwareConfigTree>(
    "/api/hardware-config",
    hcFetcher,
    { revalidateOnFocus: false },
  );
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!hcData) return;
    let defaultId: string | null = null;
    for (const loc of hcData.locations ?? []) {
      for (const z of loc.zones ?? []) {
        for (const r of z.readers ?? []) {
          if (r.network_address === DEFAULT_READER_IP) {
            defaultId = r.id;
            break;
          }
        }
        if (defaultId) break;
      }
      if (defaultId) break;
      for (const r of loc.unzoned_readers ?? []) {
        if (r.network_address === DEFAULT_READER_IP) {
          defaultId = r.id;
          break;
        }
      }
      if (defaultId) break;
    }
    appliedDefaultRef.current = true;
    if (defaultId) {
      setSelectedReaders(new Set([defaultId]));
      // Operator request: entering the page auto-starts the default reader (.16),
      // matching Bulk Status. Releases on unmount via the existing cleanup.
      const startId = defaultId;
      void (async () => {
        try {
          const r = await fetch("/api/scan-sessions/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ readerId: startId, kind: "bulk-import" }),
          });
          const j = (await r.json().catch(() => null)) as
            | { ok?: boolean; sessionId?: string }
            | null;
          if (j?.ok && j.sessionId) {
            setScanSessionId(j.sessionId);
            setScanning(true);
          }
        } catch {
          /* non-fatal: operator can still click Start scanning */
        }
      })();
    }
  }, [hcData]);

  // --- Scan state ------------------------------------------------------
  const [scanning, setScanning] = useState(false);
  const [scanSessionId, setScanSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);

  // Grouped rows keyed by custom_sku_id. Map preserves insertion order
  // so the table is deterministic during scan; sort overlays this.
  const [groups, setGroups] = useState<Map<string, GroupedRow>>(() => new Map());

  // EPCs the operator has explicitly trash-iconed from a modal. We
  // suppress future SSE re-additions of these so the operator's intent
  // sticks across continued scanning. Cleared by "Clear list".
  const [suppressedEpcs, setSuppressedEpcs] = useState<Set<string>>(() => new Set());

  // Per-SKU checkbox: when true, ALL EPCs of that SKU are selected.
  // Per-EPC selection lives at the modal level (selectedEpcs) — the SKU
  // checkbox is a convenience that adds/removes all EPCs of the group.
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(() => new Set());
  // Explicit per-EPC selection state (drives the commit payload). The
  // SKU checkbox just unions/excludes the SKU's epcs.
  const [selectedEpcs, setSelectedEpcs] = useState<Set<string>>(() => new Set());

  // --- Sort state ------------------------------------------------------
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev !== key) {
        setSortDir("asc");
        return key;
      }
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return prev;
    });
  }, []);

  // --- Modal state -----------------------------------------------------
  const [modalSku, setModalSku] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // SSE → batch → /scan → merge into groups
  // ------------------------------------------------------------------
  // SSE drops raw EPCs into a buffer; a short interval flushes them to
  // the server in batches so we don't fire one request per tag. The
  // server enforces "must be new at this location" and "must decode",
  // so the workspace only ever merges fully-resolved rows.
  const pendingBufferRef = useRef<Set<string>>(new Set());
  const flushingRef = useRef(false);
  const suppressedRef = useRef(suppressedEpcs);
  useEffect(() => {
    suppressedRef.current = suppressedEpcs;
  }, [suppressedEpcs]);

  const flushPending = useCallback(async () => {
    if (flushingRef.current) return;
    if (pendingBufferRef.current.size === 0) return;
    flushingRef.current = true;
    try {
      while (pendingBufferRef.current.size > 0) {
        // Snapshot + clear so events landing mid-flight get picked up
        // on the next iteration.
        const batch = Array.from(pendingBufferRef.current);
        pendingBufferRef.current.clear();
        try {
          const r = await fetch("/api/inventory/bulk-import/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ epcs: batch }),
          });
          if (!r.ok) continue;
          const j = (await r.json()) as { ok: true; rows: EnrichedRow[] };
          if (!j.rows.length) continue;
          // Merge: drop EPCs the operator has trash-iconed, group by
          // custom_sku_id, dedup within group.
          setGroups((prev) => {
            const next = new Map(prev);
            for (const row of j.rows) {
              if (suppressedRef.current.has(row.epc)) continue;
              const g = next.get(row.custom_sku_id) ?? {
                custom_sku_id: row.custom_sku_id,
                sku: row.sku,
                upc: row.upc,
                name: row.name,
                size: row.size,
                color: row.color,
                epcs: new Map<string, EnrichedRow>(),
              };
              if (!g.epcs.has(row.epc)) g.epcs.set(row.epc, row);
              next.set(row.custom_sku_id, g);
            }
            return next;
          });
        } catch {
          // Network blip — drop this batch's EPCs back into the buffer
          // so the next flush picks them up.
          for (const epc of batch) pendingBufferRef.current.add(epc);
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!scanning) return;
    const es = new EventSource("/api/edge/stream");
    const filterDeviceIds = selectedReaders.size > 0 ? selectedReaders : null;
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || ev.data.startsWith(":")) return;
      let p: { scanContext?: string; epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { scanContext?: string; epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      if (filterDeviceIds && p.deviceId && !filterDeviceIds.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      for (const epc of list) pendingBufferRef.current.add(epc);
    };
    es.addEventListener("message", onMessage);
    // Short safety-net flush interval — keeps the table live even when
    // SSE bursts faster than the server can chew, without firing one
    // request per tag.
    const id = setInterval(() => void flushPending(), 500);
    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
      clearInterval(id);
    };
  }, [scanning, selectedReaders, flushPending]);

  // ------------------------------------------------------------------
  // Start / Stop / Clear list buttons
  // ------------------------------------------------------------------
  const onScanToggle = useCallback(async () => {
    setErrorMsg(null);
    setCommitMsg(null);
    if (busy) return;
    setBusy(true);
    try {
      if (scanning) {
        if (scanSessionId) {
          await fetch("/api/scan-sessions/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: scanSessionId }),
          });
        }
        setScanning(false);
        setScanSessionId(null);
        return;
      }
      const readerIds = Array.from(selectedReaders);
      if (readerIds.length === 0) {
        setErrorMsg("Pick at least one reader first.");
        return;
      }
      const sessionIds: string[] = [];
      for (const readerId of readerIds) {
        const r = await fetch("/api/scan-sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ readerId, kind: "bulk-import" }),
        });
        const j = (await r.json().catch(() => null)) as
          | { ok: boolean; sessionId?: string; reason?: string }
          | null;
        if (!j?.ok || !j.sessionId) {
          setErrorMsg(`Could not start reader (${j?.reason ?? "unknown"}).`);
          for (const id of sessionIds) {
            void fetch("/api/scan-sessions/end", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: id }),
            });
          }
          return;
        }
        sessionIds.push(j.sessionId);
      }
      setScanSessionId(sessionIds[0] ?? null);
      setScanning(true);
    } finally {
      setBusy(false);
    }
  }, [busy, scanning, scanSessionId, selectedReaders]);

  // Make sure a closed tab doesn't leave the reader awake.
  useEffect(() => {
    return () => {
      if (scanSessionId) {
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ sessionId: scanSessionId }),
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onClearList = useCallback(() => {
    setGroups(new Map());
    setSelectedSkus(new Set());
    setSelectedEpcs(new Set());
    setSuppressedEpcs(new Set());
    setCommitMsg(null);
    setErrorMsg(null);
  }, []);

  // ------------------------------------------------------------------
  // Add to inventory: POST selected EPCs to /commit
  // ------------------------------------------------------------------
  const onAddToInventory = useCallback(async () => {
    if (busy) return;
    setErrorMsg(null);
    setCommitMsg(null);
    if (selectedEpcs.size === 0) {
      setErrorMsg("Select at least one EPC or SKU to add.");
      return;
    }
    // Build the items[] payload: { epc, custom_sku_id }.
    const items: Array<{ epc: string; custom_sku_id: string }> = [];
    for (const [skuId, g] of groups.entries()) {
      for (const [epc] of g.epcs.entries()) {
        if (selectedEpcs.has(epc)) items.push({ epc, custom_sku_id: skuId });
      }
    }
    if (items.length === 0) {
      setErrorMsg("No EPCs to add (the selection is stale).");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/inventory/bulk-import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok: true; inserted: number; skipped: number }
        | { error?: string }
        | null;
      if (!j || !("ok" in j) || !j.ok) {
        const msg = (j as { error?: string } | null)?.error ?? "commit failed";
        setErrorMsg(msg);
        return;
      }
      // Drop the committed EPCs from the local groups (they're now in
      // the system; the /scan filter will exclude them on future scans
      // anyway). Empty groups disappear too.
      setGroups((prev) => {
        const next = new Map<string, GroupedRow>();
        for (const [skuId, g] of prev.entries()) {
          const remaining = new Map<string, EnrichedRow>();
          for (const [epc, row] of g.epcs.entries()) {
            if (!selectedEpcs.has(epc)) remaining.set(epc, row);
          }
          if (remaining.size > 0) {
            next.set(skuId, { ...g, epcs: remaining });
          }
        }
        return next;
      });
      setSelectedEpcs(new Set());
      setSelectedSkus(new Set());
      setCommitMsg(
        `Added ${j.inserted} EPC${j.inserted === 1 ? "" : "s"} to inventory.` +
          (j.skipped > 0 ? ` ${j.skipped} skipped (already existed).` : ""),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, groups, selectedEpcs]);

  // ------------------------------------------------------------------
  // Selection helpers
  // ------------------------------------------------------------------
  const toggleSkuCheck = useCallback(
    (skuId: string) => {
      setSelectedSkus((prev) => {
        const next = new Set(prev);
        const wasSelected = next.has(skuId);
        if (wasSelected) next.delete(skuId);
        else next.add(skuId);
        // Sync per-EPC state: include/exclude the SKU's EPCs.
        const g = groups.get(skuId);
        if (g) {
          setSelectedEpcs((prevEpcs) => {
            const ns = new Set(prevEpcs);
            if (wasSelected) {
              for (const [epc] of g.epcs.entries()) ns.delete(epc);
            } else {
              for (const [epc] of g.epcs.entries()) ns.add(epc);
            }
            return ns;
          });
        }
        return next;
      });
    },
    [groups],
  );

  const toggleEpcCheck = useCallback(
    (epc: string, skuId: string) => {
      setSelectedEpcs((prev) => {
        const next = new Set(prev);
        if (next.has(epc)) next.delete(epc);
        else next.add(epc);
        // Re-sync the parent SKU checkbox: it's checked iff ALL EPCs
        // of the SKU are selected.
        const g = groups.get(skuId);
        if (g) {
          const allChecked = Array.from(g.epcs.keys()).every((e) =>
            e === epc ? next.has(e) : next.has(e),
          );
          setSelectedSkus((prevSkus) => {
            const ns = new Set(prevSkus);
            if (allChecked) ns.add(skuId);
            else ns.delete(skuId);
            return ns;
          });
        }
        return next;
      });
    },
    [groups],
  );

  const removeEpcLocally = useCallback(
    (epc: string, skuId: string) => {
      setGroups((prev) => {
        const next = new Map(prev);
        const g = next.get(skuId);
        if (!g) return prev;
        const remaining = new Map(g.epcs);
        remaining.delete(epc);
        if (remaining.size === 0) {
          next.delete(skuId);
        } else {
          next.set(skuId, { ...g, epcs: remaining });
        }
        return next;
      });
      setSelectedEpcs((prev) => {
        const next = new Set(prev);
        next.delete(epc);
        return next;
      });
      setSuppressedEpcs((prev) => {
        const next = new Set(prev);
        next.add(epc);
        return next;
      });
    },
    [],
  );

  // ------------------------------------------------------------------
  // Derived: rows array with grouping + sort applied
  // ------------------------------------------------------------------
  const rows = useMemo(() => {
    const arr = Array.from(groups.values());
    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      const cmp = (a: GroupedRow, b: GroupedRow): number => {
        if (sortKey === "qty") {
          return (a.epcs.size - b.epcs.size) * dir;
        }
        const pick = (g: GroupedRow): string => {
          switch (sortKey) {
            case "sku": return g.sku ?? "";
            case "upc": return g.upc ?? "";
            case "name": return g.name ?? "";
            case "color": return g.color ?? "";
            case "size": return g.size ?? "";
          }
        };
        const sa = pick(a).toLowerCase();
        const sb = pick(b).toLowerCase();
        if (sa < sb) return -1 * dir;
        if (sa > sb) return 1 * dir;
        return 0;
      };
      arr.sort(cmp);
    }
    return arr;
  }, [groups, sortKey, sortDir]);

  const modalGroup = modalSku ? groups.get(modalSku) ?? null : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        <button
          type="button"
          onClick={() => void onScanToggle()}
          disabled={busy || selectedReaders.size === 0}
          className={
            "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 " +
            (scanning
              ? "border-red-400/50 bg-red-500/15 text-red-300 hover:bg-red-500/25"
              : "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25")
          }
        >
          {scanning ? (
            <>
              <Square className="h-3.5 w-3.5" />
              Stop scanning
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              Start scanning
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onClearList}
          disabled={busy || groups.size === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-sm text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear list
        </button>

        <div className="flex min-w-[260px] flex-1 items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-[var(--wms-muted)]" />
          <ReaderPicker
            selected={selectedReaders}
            onChange={setSelectedReaders}
            hidePosDedicated
          />
        </div>

        <button
          type="button"
          onClick={() => void onAddToInventory()}
          disabled={busy || selectedEpcs.size === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-accent)]/10 px-3 py-1.5 font-mono text-sm font-semibold text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PackagePlus className="h-3.5 w-3.5" />
          Add to inventory ({selectedEpcs.size})
        </button>
      </div>

      {errorMsg ? (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300">
          {errorMsg}
        </div>
      ) : null}
      {commitMsg ? (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-emerald-300">
          {commitMsg}
        </div>
      ) : null}

      {/* Table */}
      <div className="overflow-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[1100px] border-collapse font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-left">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && rows.every((g) => selectedSkus.has(g.custom_sku_id))}
                  disabled={rows.length === 0}
                  onChange={() => {
                    const allChecked = rows.every((g) => selectedSkus.has(g.custom_sku_id));
                    if (allChecked) {
                      setSelectedSkus(new Set());
                      setSelectedEpcs(new Set());
                    } else {
                      const allSkus = new Set(rows.map((g) => g.custom_sku_id));
                      const allEpcs = new Set<string>();
                      for (const g of rows) {
                        for (const [epc] of g.epcs.entries()) allEpcs.add(epc);
                      }
                      setSelectedSkus(allSkus);
                      setSelectedEpcs(allEpcs);
                    }
                  }}
                  className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
                />
              </th>
              {(
                [
                  { label: "Custom SKU", key: "sku" as const },
                  { label: "UPC", key: "upc" as const },
                  { label: "Item Name", key: "name" as const },
                  { label: "Color", key: "color" as const },
                  { label: "Size", key: "size" as const },
                  { label: "Qty", key: "qty" as const },
                ] as const
              ).map((c) => {
                const active = sortKey === c.key;
                return (
                  <th key={c.key} className="px-3 py-2 text-left">
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={
                        "inline-flex items-center gap-1 select-none hover:text-[var(--wms-fg)] " +
                        (active ? "text-[var(--wms-accent)]" : "")
                      }
                      title={`Sort by ${c.label}`}
                    >
                      <span>{c.label}</span>
                      {active ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-30" />
                      )}
                    </button>
                  </th>
                );
              })}
              <th className="px-3 py-2 text-left">RFID</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  {scanning
                    ? "Listening… new tags will land here."
                    : "Click Start scanning to begin."}
                </td>
              </tr>
            ) : (
              rows.map((g) => {
                const isSkuChecked = selectedSkus.has(g.custom_sku_id);
                return (
                  <tr
                    key={g.custom_sku_id}
                    className={
                      "border-b border-[var(--wms-border)]/40 hover:bg-[var(--wms-surface-elevated)]/40 " +
                      (isSkuChecked
                        ? "bg-[color-mix(in_srgb,var(--wms-accent)_6%,transparent)]"
                        : "")
                    }
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSkuChecked}
                        onChange={() => toggleSkuCheck(g.custom_sku_id)}
                        className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
                      />
                    </td>
                    <td className="px-3 py-2 font-semibold text-teal-400/90">{g.sku}</td>
                    <td className="px-3 py-2 text-[var(--wms-muted)]">{g.upc ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--wms-fg)]" title={g.name}>
                      {g.name}
                    </td>
                    <td className="px-3 py-2 text-[var(--wms-muted)]">{g.color ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--wms-muted)]">{g.size ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[var(--wms-fg)] tabular-nums">
                      {g.epcs.size}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setModalSku(g.custom_sku_id)}
                        className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-0.5 text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
                        title={`Show ${g.epcs.size} EPC${g.epcs.size === 1 ? "" : "s"}`}
                      >
                        <Tag className="h-3 w-3" />
                        EPC ({g.epcs.size})
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        Filters in place: must pass the Carbon Jeans EPC formula, must NOT
        already exist in items at this location (any status), must resolve to
        a catalog SKU. Committing flips the EPC&apos;s status to in-stock
        (LIVE) at this location; once committed, the EPC stops appearing in
        this list for future scans.
      </div>

      {/* EPC modal */}
      {modalGroup ? (
        <EpcListModal
          group={modalGroup}
          selectedEpcs={selectedEpcs}
          onClose={() => setModalSku(null)}
          onToggleEpc={(epc) => toggleEpcCheck(epc, modalGroup.custom_sku_id)}
          onRemoveEpc={(epc) => removeEpcLocally(epc, modalGroup.custom_sku_id)}
        />
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// EPC list modal: per-SKU list of EPCs with checkbox + trash icon.
// ───────────────────────────────────────────────────────────────────────
function EpcListModal({
  group,
  selectedEpcs,
  onClose,
  onToggleEpc,
  onRemoveEpc,
}: {
  group: GroupedRow;
  selectedEpcs: Set<string>;
  onClose: () => void;
  onToggleEpc: (epc: string) => void;
  onRemoveEpc: (epc: string) => void;
}) {
  // Esc closes (mirrors the defective-epcs modal pattern).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const epcs = useMemo(() => Array.from(group.epcs.keys()), [group]);
  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-3">
            <div>
              <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
                EPCs · {group.sku}
              </h2>
              <p className="mt-0.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                {group.name}
                {group.color ? ` · ${group.color}` : ""}
                {group.size ? ` · ${group.size}` : ""}
                {" — "}
                {epcs.length} tag{epcs.length === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-1.5 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <ul className="flex-1 divide-y divide-[var(--wms-border)]/40 overflow-auto p-2">
            {epcs.map((epc) => {
              const checked = selectedEpcs.has(epc);
              return (
                <li
                  key={epc}
                  className={
                    "flex items-center gap-3 rounded px-2 py-1.5 hover:bg-[var(--wms-surface-elevated)]/40 " +
                    (checked
                      ? "bg-[color-mix(in_srgb,var(--wms-accent)_6%,transparent)]"
                      : "")
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleEpc(epc)}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--wms-accent)]"
                  />
                  <Tag className="h-3.5 w-3.5 shrink-0 text-[var(--wms-accent)]" />
                  <span className="flex-1 truncate font-mono text-xs font-semibold text-teal-400/90">
                    {epc}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveEpc(epc)}
                    className="inline-flex items-center gap-1 rounded border border-red-400/30 bg-red-400/5 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide text-red-300 hover:bg-red-400/15"
                    title="Remove from list (will be suppressed from re-scans this session)"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  );
}
