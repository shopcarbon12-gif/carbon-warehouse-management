"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Radio, ScanLine, Trash2 } from "lucide-react";

import { bulkStatusOptionsForUi } from "@/lib/inventory/bulk-wms-status-options";
import { ReaderPicker } from "@/components/shared/reader-picker";
import { useReaderWake } from "@/components/shared/use-reader-wake";
import {
  RssiProximitySlider,
  useRssiThreshold,
  passesRssi,
} from "@/components/shared/rssi-proximity-slider";

/** IP of the reader the operator wants pre-selected when this workspace
 *  mounts. Operator request 2026-05-26: .15 covers the bulk-status table
 *  area; auto-selecting it removes a click from the common flow. The
 *  default is applied once, on first data load, then never again — so a
 *  cashier who deselects it (or picks a different reader) isn't fought
 *  by a re-application. */
const BULK_STATUS_DEFAULT_READER_IP = "192.168.1.87";

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
import {
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

/** Per-EPC row in the bulk-status table — populated as scans roll in. */
type ScannedRow = {
  epc: string;
  /** Catalog enrichment (matches the antenna-test workspace shape). */
  sku: string | null;
  ls_system_id: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  /** Current status — populated from the catalog lookup. Updated in-place
   *  after Apply succeeds so the operator sees the new badge without a
   *  page refresh. */
  status: string | null;
  location_code: string | null;
  bin_code: string | null;
  /** Strongest per-tag RSSI seen this session (dBm, negative). null = none reported. */
  rssi: number | null;
  /** Tracks whether enrichment has been attempted (success or fail). */
  looked_up: boolean;
};

type LookupRow = {
  epc: string;
  sku: string;
  status: string;
  name: string | null;
  color: string | null;
  size: string | null;
  location_code: string;
  bin_code: string | null;
  sku_ls_system_id: string | null;
};

/** Lookup endpoint cap — server's zod schema rejects bigger payloads. */
const LOOKUP_CHUNK = 200;

export function BulkStatusWorkspace({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  // Warm the .15 reader while this page is open so it's ready before the
  // operator clicks Start scan. Capture is gated by the Start button.
  useReaderWake({ active: true, kind: "bulk-status", networkAddresses: ["192.168.1.87"] });

  const options = bulkStatusOptionsForUi(isSuperAdmin);
  const [target, setTarget] = useState<string>(options[0]?.value ?? "in-stock");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 8);

  // Scan state — exactly the pattern Transfer Out uses. Empty picker accepts
  // all readers (consistent with item-5 spec); pick one or more readers to
  // narrow the firehose.
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(scanning);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(
    () => new Set(),
  );
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  // Pre-select the default reader (currently .15) when this workspace
  // mounts. Fires exactly once — `appliedDefaultRef` guards against the
  // SWR cache re-firing the effect on focus/revalidate from re-applying
  // and stomping on the operator's manual edits.
  const { data: hcData } = useSWR<HardwareConfigTree>(
    "/api/hardware-config",
    hcFetcher,
    { revalidateOnFocus: false },
  );
  // Active scan-session ids (one per woken reader). Ref so the unmount cleanup
  // can end them all without re-running on every render.
  const scanSessionIdsRef = useRef<string[]>([]);

  const stopScan = useCallback(() => {
    const ids = scanSessionIdsRef.current;
    scanSessionIdsRef.current = [];
    setScanning(false);
    for (const id of ids) {
      void fetch("/api/scan-sessions/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
        keepalive: true,
      }).catch(() => {});
    }
  }, []);

  // Wake the given readers via scan-sessions (kind=bulk-status). The agent
  // supervisor spawns each reader within ~250ms, overriding scan_paused_at,
  // and Hardware Config shows them as "scanning".
  const startScan = useCallback(async (readerIds: string[]) => {
    if (readerIds.length === 0) {
      setMsg("Pick at least one reader first.");
      return;
    }
    setMsg(null);
    const newIds: string[] = [];
    for (const readerId of readerIds) {
      try {
        const res = await fetch("/api/scan-sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ readerId, kind: "bulk-status", context: { page: "bulk-status" } }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sessionId?: string;
          reason?: string;
          error?: string;
        };
        if (res.ok && j.ok && j.sessionId) newIds.push(j.sessionId);
        else setMsg(`Could not start a reader (${j.reason ?? j.error ?? "unknown"}).`);
      } catch {
        setMsg("Network error starting reader.");
      }
    }
    if (newIds.length > 0) {
      scanSessionIdsRef.current = [...scanSessionIdsRef.current, ...newIds];
      setScanning(true);
    }
  }, []);

  const onScanToggle = useCallback(() => {
    if (scanning) stopScan();
    else void startScan(Array.from(selectedReadersRef.current));
  }, [scanning, startScan, stopScan]);

  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!hcData) return;
    // Walk zones + unzoned readers across locations to find the IP match.
    let defaultId: string | null = null;
    for (const loc of hcData.locations ?? []) {
      for (const z of loc.zones ?? []) {
        for (const r of z.readers ?? []) {
          if (r.network_address === BULK_STATUS_DEFAULT_READER_IP) {
            defaultId = r.id;
            break;
          }
        }
        if (defaultId) break;
      }
      if (defaultId) break;
      for (const r of loc.unzoned_readers ?? []) {
        if (r.network_address === BULK_STATUS_DEFAULT_READER_IP) {
          defaultId = r.id;
          break;
        }
      }
      if (defaultId) break;
    }
    appliedDefaultRef.current = true; // mark applied either way — no retry
    if (defaultId) {
      // Pre-select .15 only. The reader is kept WARM by useReaderWake while
      // this page is open; capture starts when the operator clicks Start scan.
      setSelectedReaders(new Set([defaultId]));
    }
  }, [hcData]);

  // End all sessions when leaving the page so readers return to default-paused.
  useEffect(() => {
    return () => {
      const ids = scanSessionIdsRef.current;
      scanSessionIdsRef.current = [];
      for (const id of ids) {
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id }),
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, []);

  // Table state — Map keyed by EPC so duplicate reads collapse to one row.
  const [rows, setRows] = useState<Map<string, ScannedRow>>(new Map());
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Trashed EPCs stay hidden for the session (re-surface on Clear staged).
  const suppressedRef = useRef<Set<string>>(new Set());

  // RSSI proximity slider — shown ONLY when .15 is the single selected reader.
  const [rssiThreshold, setRssiThreshold] = useRssiThreshold("wms.bulk-status.rssi");
  const reader70Id = useMemo(() => {
    for (const loc of hcData?.locations ?? []) {
      for (const z of loc.zones ?? [])
        for (const r of z.readers ?? [])
          if (r.network_address === BULK_STATUS_DEFAULT_READER_IP) return r.id;
      for (const r of loc.unzoned_readers ?? [])
        if (r.network_address === BULK_STATUS_DEFAULT_READER_IP) return r.id;
    }
    return null;
  }, [hcData]);
  const showRssi =
    selectedReaders.size === 1 && reader70Id !== null && selectedReaders.has(reader70Id);

  // Edge-stream subscription — accept reads from selected readers (or all
  // when picker is empty). Each new EPC becomes a row; duplicates are no-op.
  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!scanningRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string; epcRssiMap?: Record<string, number> };
      try {
        p = JSON.parse(ev.data) as typeof p;
      } catch {
        return;
      }
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e))
        // Drop EPCs the operator has trash-iconed this session (re-surface on Clear staged).
        .filter((e) => !suppressedRef.current.has(e));
      if (list.length === 0) return;
      const rssiMap = p.epcRssiMap ?? {};
      const next = new Map(rowsRef.current);
      let changed = false;
      for (const epc of list) {
        const rssi = typeof rssiMap[epc] === "number" ? rssiMap[epc] : null;
        const cur = next.get(epc);
        if (!cur) {
          next.set(epc, {
            epc,
            sku: null,
            ls_system_id: null,
            name: null,
            color: null,
            size: null,
            status: null,
            location_code: null,
            bin_code: null,
            rssi,
            looked_up: false,
          });
          changed = true;
        } else if (rssi != null && (cur.rssi == null || rssi > cur.rssi)) {
          // Keep the strongest (closest) sighting so the slider tracks proximity.
          next.set(epc, { ...cur, rssi });
          changed = true;
        }
      }
      if (changed) setRows(next);
    };
    return () => es.close();
  }, []);

  // Catalog enrichment — chunked at 200 to dodge the lookup endpoint's
  // zod cap. On failure, un-mark the chunk so we retry next render-tick.
  // Same pattern as the antenna-test workspace.
  useEffect(() => {
    const pending: string[] = [];
    for (const r of rows.values()) {
      if (r.looked_up) continue;
      pending.push(r.epc);
    }
    if (pending.length === 0) return;
    // Optimistically mark looked_up so we don't re-enqueue the same EPCs
    // on every render tick while the request is in flight.
    {
      const next = new Map(rows);
      for (const epc of pending) {
        const cur = next.get(epc);
        if (cur) next.set(epc, { ...cur, looked_up: true });
      }
      setRows(next);
    }
    void (async () => {
      for (let i = 0; i < pending.length; i += LOOKUP_CHUNK) {
        const chunk = pending.slice(i, i + LOOKUP_CHUNK);
        try {
          const res = await fetch("/api/operations/transfers/lookup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ epcs: chunk }),
          });
          if (!res.ok) {
            // Un-mark so the next render retries.
            const next = new Map(rowsRef.current);
            for (const e of chunk) {
              const cur = next.get(e);
              if (cur) next.set(e, { ...cur, looked_up: false });
            }
            setRows(next);
            continue;
          }
          const data = (await res.json()) as { rows?: LookupRow[] };
          const next = new Map(rowsRef.current);
          for (const r of data.rows ?? []) {
            const epc = r.epc.toUpperCase();
            const cur = next.get(epc);
            if (!cur) continue;
            next.set(epc, {
              ...cur,
              sku: r.sku ?? null,
              ls_system_id: r.sku_ls_system_id ?? null,
              name: r.name,
              color: r.color,
              size: r.size,
              status: r.status,
              location_code: r.location_code ?? null,
              bin_code: r.bin_code,
              looked_up: true,
            });
          }
          setRows(next);
        } catch {
          const next = new Map(rowsRef.current);
          for (const e of chunk) {
            const cur = next.get(e);
            if (cur) next.set(e, { ...cur, looked_up: false });
          }
          setRows(next);
        }
      }
    })();
  }, [rows]);

  const allChecked = rows.size > 0 && checked.size === rows.size;
  const toggleAll = () => {
    if (allChecked) setChecked(new Set());
    else setChecked(new Set(rows.keys()));
  };
  const toggleOne = (epc: string) => {
    const next = new Set(checked);
    if (next.has(epc)) next.delete(epc);
    else next.add(epc);
    setChecked(next);
  };

  // Per-row trash → drop from the staged set and keep it out for the session
  // (does NOT touch the chip; just un-stages it before Apply).
  const trashRow = (epc: string) => {
    suppressedRef.current.add(epc);
    setRows((prev) => {
      if (!prev.has(epc)) return prev;
      const next = new Map(prev);
      next.delete(epc);
      return next;
    });
    setChecked((prev) => {
      if (!prev.has(epc)) return prev;
      const next = new Set(prev);
      next.delete(epc);
      return next;
    });
  };

  const clearAll = () => {
    suppressedRef.current = new Set();
    setRows(new Map());
    setChecked(new Set());
    setScanning(false);
    setMsg(null);
  };

  const apply = async () => {
    const epcs = [...checked];
    if (!epcs.length) {
      setMsg("Check at least one EPC.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/inventory/bulk-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs, targetStatus: target, override }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        updated?: number;
      };
      if (!res.ok) throw new Error(j.error ?? "Request failed");
      // Update each affected row's status badge in-place; uncheck them so
      // the operator can see the change and queue another batch without
      // re-clicking individuals.
      const next = new Map(rowsRef.current);
      for (const epc of epcs) {
        const cur = next.get(epc);
        if (cur) next.set(epc, { ...cur, status: target });
      }
      setRows(next);
      setChecked(new Set());
      setMsg(`Updated ${j.updated ?? 0} EPC(s) to ${target}.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const sortedRows = useMemo(() => {
    const arr = [...rows.values()];
    return showRssi ? arr.filter((r) => passesRssi(r.rssi, rssiThreshold)) : arr;
  }, [rows, showRssi, rssiThreshold]);
  const targetOption = options.find((o) => o.value === target);
  const applyDisabled = busy || checked.size === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="font-mono text-xs text-[var(--wms-muted)]">
        {!isSuperAdmin
          ? "System workflow targets (in transit, pending visibility, pending transaction) are hidden — Super Admin only. Items in Super Admin–locked statuses cannot be changed here."
          : "Super Admin: all Clean 10 targets are available; use Override for risky transitions."}
      </p>

      {/* Top row — Target ▼ | Apply bulk status, equal widths. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 font-mono text-xs text-[var(--wms-muted)]">
          Target status
          <select
            className="rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_10%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={applyDisabled}
          onClick={() => void apply()}
          title={
            checked.size === 0
              ? "Check at least one EPC in the table below."
              : `Will set ${checked.size} EPC(s) to ${targetOption?.label ?? target}.`
          }
          className="self-end rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-sm font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? "Working…"
            : checked.size === 0
              ? "Apply bulk status"
              : `Apply to ${checked.size} selected`}
        </button>
      </div>

      <label className="flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]">
        <input
          type="checkbox"
          checked={override}
          onChange={(e) => setOverride(e.target.checked)}
          disabled={!isSuperAdmin}
        />
        Allow risky transitions (Super Admin only)
      </label>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={() => onScanToggle()}
          disabled={!scanning && selectedReaders.size === 0}
          className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
          {scanning ? "Scanning… (click to stop)" : "Start scan"}
        </button>
        <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} hidePosDedicated />
        <button
          type="button"
          disabled={rows.size === 0}
          onClick={clearAll}
          title="Wipe the table — drops every scanned row."
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
        >
          <ScanLine className="h-4 w-4" />
          Clear staged
        </button>
        <span className="ml-auto font-mono text-[10px] text-[var(--wms-muted)]">
          <strong className="text-[var(--wms-fg)]">{rows.size}</strong> scanned ·{" "}
          <strong className="text-[var(--wms-fg)]">{checked.size}</strong> checked
        </span>
      </div>

      {showRssi ? (
        <RssiProximitySlider
          value={rssiThreshold}
          onChange={setRssiThreshold}
          hint=".15 proximity filter"
        />
      ) : null}

      <DataTableContainer maxHeight="min(70vh, 640px)">
        <table
          ref={tableRef}
          className="w-full min-w-[1000px] border-collapse text-sm"
          style={{ tableLayout: pickTableLayout(colWidths) }}
        >
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              {[
                { label: "", sel: true },
                { label: "EPC" },
                { label: "SKU" },
                { label: "System ID" },
                { label: "Description" },
                { label: "RSSI" },
                { label: "Current status" },
                { label: "Loc · Bin" },
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
                        disabled={rows.size === 0}
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
              <th className="w-11 whitespace-nowrap px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-8 text-center text-xs text-[var(--wms-muted)]"
                >
                  {scanning
                    ? "Waiting for first read…"
                    : "Click Start scan to begin populating the table."}
                </td>
              </tr>
            )}
            {sortedRows.map((row) => {
              const desc = [row.name, row.color, row.size]
                .filter((s) => s && s.trim())
                .join(" · ");
              const isChecked = checked.has(row.epc);
              const isUnknown = row.looked_up && row.sku === null;
              return (
                <tr
                  key={row.epc}
                  className="border-t border-[var(--wms-border)]"
                >
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleOne(row.epc)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-teal-400/90">
                    {row.epc}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {row.sku ?? (
                      <span className="text-[var(--wms-muted)]">
                        {isUnknown ? "(unknown — see Defective EPCs)" : "—"}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {row.ls_system_id ?? (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                    {desc || <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-[var(--wms-muted)]">
                    {row.rssi != null ? `${row.rssi} dBm` : "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                    {row.status ? (
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white ${
                          row.status === "in-stock"
                            ? "bg-emerald-600"
                            : row.status === "tag_killed"
                              ? "bg-red-600"
                              : "bg-slate-500"
                        }`}
                      >
                        {row.status}
                      </span>
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {row.location_code ? (
                      <>
                        {row.location_code}
                        {row.bin_code ? ` · ${row.bin_code}` : ""}
                      </>
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => trashRow(row.epc)}
                      title="Un-stage this row (removes it from the list; does not change the chip)"
                      className="inline-flex items-center rounded border border-red-400/30 bg-red-400/5 px-1.5 py-0.5 text-red-300 hover:bg-red-400/15"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataTableContainer>

      {msg ? (
        <p className="font-mono text-sm text-[var(--wms-fg)]">{msg}</p>
      ) : null}
    </div>
  );
}
