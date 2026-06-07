"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Radio, Download, Trash2 } from "lucide-react";

import { ReaderPicker } from "@/components/shared/reader-picker";
import { DataTableContainer } from "@/components/shared/data-table";
import { rowsToCsv, downloadCsv } from "@/lib/csv-export";
import type {
  HardwareConfigTree,
  HardwareAntennaRow,
} from "@/lib/server/hardware-config";

const fetcher = async (url: string): Promise<HardwareConfigTree> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("hardware-config fetch failed");
  return r.json() as Promise<HardwareConfigTree>;
};

/** One row per UNIQUE EPC. The source reader is the first reader that read
 *  it; `readerIds` keeps every reader that has seen it so we can flag when
 *  more than one picked it up. */
type ScanRow = {
  epc: string;
  sourceReaderId: string;
  readerIds: Set<string>;
  /** antenna_id (UUID) of the strongest sighting. */
  antennaId: string | null;
  /** strongest (closest) RSSI seen, dBm (negative). */
  rssi: number | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  // catalog enrichment
  sku: string | null;
  ls_system_id: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  status: string | null;
  location_code: string | null;
  bin_code: string | null;
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

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function ScanEpcWorkspace() {
  const { data: hcData } = useSWR<HardwareConfigTree>(
    "/api/hardware-config",
    fetcher,
    { revalidateOnFocus: false },
  );

  // Flatten the tree into reader + antenna lookups for attribution.
  const { readerById, antennaById } = useMemo(() => {
    const r = new Map<
      string,
      { name: string; ip: string | null; antennas: HardwareAntennaRow[] }
    >();
    const a = new Map<
      string,
      { name: string; number: number | null; readerName: string }
    >();
    for (const loc of hcData?.locations ?? []) {
      const readers = [
        ...(loc.zones ?? []).flatMap((z) => z.readers ?? []),
        ...(loc.unzonedReaders ?? []),
      ];
      for (const rd of readers) {
        r.set(rd.id, {
          name: rd.name,
          ip: rd.network_address,
          antennas: rd.antennas ?? [],
        });
        for (const ant of rd.antennas ?? []) {
          a.set(ant.id, {
            name: ant.name,
            number:
              typeof ant.config?.antenna_number === "number"
                ? (ant.config.antenna_number as number)
                : null,
            readerName: rd.name,
          });
        }
      }
    }
    return { readerById: r, antennaById: a };
  }, [hcData]);

  // ── Reader selection ────────────────────────────────────────────────
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(
    () => new Set(),
  );
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  // ── Scan lifecycle ──────────────────────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(scanning);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);
  const scanSessionIdsRef = useRef<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

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
          body: JSON.stringify({
            readerId,
            kind: "scan-epc",
            context: { page: "scan-epc" },
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sessionId?: string;
          reason?: string;
          error?: string;
        };
        if (res.ok && j.ok && j.sessionId) newIds.push(j.sessionId);
        else
          setMsg(
            `Could not start ${readerById.get(readerId)?.name ?? "a reader"} (${
              j.reason ?? j.error ?? "unknown"
            }).`,
          );
      } catch {
        setMsg("Network error starting a reader.");
      }
    }
    if (newIds.length > 0) {
      scanSessionIdsRef.current = [...scanSessionIdsRef.current, ...newIds];
      setScanning(true);
    }
  }, [readerById]);

  const onScanToggle = useCallback(() => {
    if (scanning) stopScan();
    else void startScan(Array.from(selectedReadersRef.current));
  }, [scanning, startScan, stopScan]);

  // End all sessions on unmount so readers return to default-paused.
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

  // ── Per-reader power sliders ────────────────────────────────────────
  // dBm per selected reader. Seeded from the reader's antenna config on
  // first selection. Writing PATCHes the antenna(s); the agent applies it
  // on its next config-poll (~60 s) — labelled in the UI.
  const [readerPower, setReaderPower] = useState<Map<string, number>>(
    () => new Map(),
  );
  const powerTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Seed power for newly-selected readers from their configured antenna power.
  useEffect(() => {
    setReaderPower((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const rid of selectedReaders) {
        if (next.has(rid)) continue;
        const ant = readerById.get(rid)?.antennas?.[0];
        const cfgPwr =
          ant && typeof ant.config?.transmit_power_dbm === "number"
            ? (ant.config.transmit_power_dbm as number)
            : 33;
        next.set(rid, cfgPwr);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedReaders, readerById]);

  const applyPower = useCallback(
    (readerId: string, dbm: number) => {
      const antennas = readerById.get(readerId)?.antennas ?? [];
      const powerArg = Math.round(dbm * 10);
      for (const ant of antennas) {
        void fetch(`/api/hardware-config/antennas/${ant.id}/behaviour`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            powerArg,
            readTimeMs: 1000,
            cycleMode: "infinite",
            tagFocus: false,
          }),
        }).catch(() => {});
      }
    },
    [readerById],
  );

  const onPowerChange = useCallback(
    (readerId: string, dbm: number) => {
      setReaderPower((prev) => {
        const next = new Map(prev);
        next.set(readerId, dbm);
        return next;
      });
      const timers = powerTimers.current;
      const existing = timers.get(readerId);
      if (existing) clearTimeout(existing);
      timers.set(
        readerId,
        setTimeout(() => applyPower(readerId, dbm), 450),
      );
    },
    [applyPower],
  );

  // ── EPC table (one row per unique EPC) ──────────────────────────────
  const [rows, setRows] = useState<Map<string, ScanRow>>(new Map());
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Edge-stream subscription. Each payload is from ONE reader (deviceId);
  // we attribute each EPC to its source reader + antenna + RSSI, deduped.
  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!scanningRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: {
        epcs?: string[];
        deviceId?: string;
        epcRssiMap?: Record<string, number>;
        epcAntennaMap?: Record<string, string>;
      };
      try {
        p = JSON.parse(ev.data) as typeof p;
      } catch {
        return;
      }
      const sel = selectedReadersRef.current;
      const deviceId = p.deviceId ?? "";
      if (sel.size > 0 && deviceId && !sel.has(deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      const rssiMap = p.epcRssiMap ?? {};
      const antMap = p.epcAntennaMap ?? {};
      const now = Date.now();
      const next = new Map(rowsRef.current);
      let changed = false;
      for (const epc of list) {
        const rssi = typeof rssiMap[epc] === "number" ? rssiMap[epc] : null;
        const antId = antMap[epc] ?? null;
        const cur = next.get(epc);
        if (!cur) {
          next.set(epc, {
            epc,
            sourceReaderId: deviceId,
            readerIds: new Set(deviceId ? [deviceId] : []),
            antennaId: antId,
            rssi,
            firstSeen: now,
            lastSeen: now,
            count: 1,
            sku: null,
            ls_system_id: null,
            name: null,
            color: null,
            size: null,
            status: null,
            location_code: null,
            bin_code: null,
            looked_up: false,
          });
          changed = true;
        } else {
          const readerIds = cur.readerIds;
          if (deviceId && !readerIds.has(deviceId)) readerIds.add(deviceId);
          const stronger = rssi != null && (cur.rssi == null || rssi > cur.rssi);
          next.set(epc, {
            ...cur,
            readerIds,
            count: cur.count + 1,
            lastSeen: now,
            rssi: stronger ? rssi : cur.rssi,
            antennaId: stronger ? antId : cur.antennaId,
          });
          changed = true;
        }
      }
      if (changed) setRows(next);
    };
    return () => es.close();
  }, []);

  // Catalog enrichment — chunked at 200 (lookup endpoint zod cap).
  useEffect(() => {
    const pending: string[] = [];
    for (const r of rows.values()) if (!r.looked_up) pending.push(r.epc);
    if (pending.length === 0) return;
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

  const clearAll = () => {
    setRows(new Map());
    setMsg(null);
  };

  // ── Render helpers ──────────────────────────────────────────────────
  const sortedRows = useMemo(
    () => [...rows.values()].sort((a, b) => a.firstSeen - b.firstSeen),
    [rows],
  );

  const readerLabel = useCallback(
    (row: ScanRow) => {
      const name = readerById.get(row.sourceReaderId)?.name ?? "—";
      const extra = row.readerIds.size - 1;
      return extra > 0 ? `${name} (+${extra})` : name;
    },
    [readerById],
  );
  const readerIp = useCallback(
    (row: ScanRow) => readerById.get(row.sourceReaderId)?.ip ?? "—",
    [readerById],
  );
  const antennaLabel = useCallback(
    (row: ScanRow) => {
      if (!row.antennaId) return "—";
      const a = antennaById.get(row.antennaId);
      if (!a) return row.antennaId.slice(0, 8);
      return a.number != null ? `Ant ${a.number}` : a.name;
    },
    [antennaById],
  );

  // ── CSV export (ALL columns) ────────────────────────────────────────
  const CSV_HEADERS = [
    "EPC",
    "Reader",
    "Reader IP",
    "Antenna",
    "RSSI (dBm)",
    "Reads",
    "First seen",
    "Last seen",
    "SKU",
    "System ID",
    "Name",
    "Color",
    "Size",
    "Status",
    "Location",
    "Bin",
    "Readers (all)",
  ];
  const exportCsv = useCallback(() => {
    const data = sortedRows.map((row) => ({
      EPC: row.epc,
      Reader: readerById.get(row.sourceReaderId)?.name ?? "",
      "Reader IP": readerById.get(row.sourceReaderId)?.ip ?? "",
      Antenna: antennaLabel(row),
      "RSSI (dBm)": row.rssi ?? "",
      Reads: row.count,
      "First seen": new Date(row.firstSeen).toISOString(),
      "Last seen": new Date(row.lastSeen).toISOString(),
      SKU: row.sku ?? "",
      "System ID": row.ls_system_id ?? "",
      Name: row.name ?? "",
      Color: row.color ?? "",
      Size: row.size ?? "",
      Status: row.status ?? "",
      Location: row.location_code ?? "",
      Bin: row.bin_code ?? "",
      "Readers (all)": [...row.readerIds]
        .map((id) => readerById.get(id)?.name ?? id)
        .join(" | "),
    }));
    const csv = rowsToCsv(CSV_HEADERS, data);
    downloadCsv(`scan-epc-${new Date().toISOString().slice(0, 19)}`, csv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRows, readerById, antennaLabel]);

  const selectedReaderList = useMemo(
    () => [...selectedReaders],
    [selectedReaders],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={onScanToggle}
          disabled={!scanning && selectedReaders.size === 0}
          className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            scanning
              ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
          }`}
        >
          <Radio
            className={`h-5 w-5 ${scanning ? "text-amber-400" : "text-[var(--wms-muted)]"}`}
          />
          {scanning ? "Scanning… (click to stop)" : "Start scan"}
        </button>

        <ReaderPicker
          selected={selectedReaders}
          onChange={setSelectedReaders}
          label="Readers"
        />

        <button
          type="button"
          disabled={rows.size === 0}
          onClick={exportCsv}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>

        <button
          type="button"
          disabled={rows.size === 0}
          onClick={clearAll}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
          Clear
        </button>

        <span className="ml-auto font-mono text-[10px] text-[var(--wms-muted)]">
          <strong className="text-[var(--wms-fg)]">{rows.size}</strong> unique EPCs
        </span>
      </div>

      {/* Per-reader power sliders */}
      {selectedReaderList.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 p-3">
          <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--wms-muted)]">
            Power per reader · applies in ~1 min (agent config poll)
          </p>
          {selectedReaderList.map((rid) => {
            const meta = readerById.get(rid);
            const dbm = readerPower.get(rid) ?? 33;
            return (
              <div key={rid} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate font-mono text-xs text-[var(--wms-fg)]">
                  {meta?.name ?? rid.slice(0, 8)}
                  {meta?.ip ? (
                    <span className="text-[var(--wms-muted)]"> · {meta.ip}</span>
                  ) : null}
                </span>
                <input
                  type="range"
                  min={10}
                  max={33}
                  step={0.5}
                  value={dbm}
                  onChange={(e) => onPowerChange(rid, Number(e.target.value))}
                  className="h-2 flex-1 cursor-pointer accent-teal-500"
                />
                <span className="w-16 shrink-0 text-right font-mono text-xs text-teal-300">
                  {dbm.toFixed(1)} dBm
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Table — one row per unique EPC, with source reader */}
      <DataTableContainer maxHeight="min(70vh, 640px)">
        <table className="w-full min-w-[1200px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              {[
                "EPC",
                "Reader (source)",
                "Reader IP",
                "Antenna",
                "RSSI",
                "Reads",
                "First seen",
                "Last seen",
                "SKU",
                "System ID",
                "Description",
                "Status",
                "Loc · Bin",
              ].map((c) => (
                <th
                  key={c}
                  className="whitespace-nowrap px-3 py-2 text-left"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={13}
                  className="px-3 py-8 text-center text-xs text-[var(--wms-muted)]"
                >
                  {scanning
                    ? "Waiting for first read…"
                    : "Pick reader(s) and click Start scan."}
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => {
                const desc = [row.name, row.color, row.size]
                  .filter((s) => s && s.trim())
                  .join(" · ");
                return (
                  <tr key={row.epc} className="border-t border-[var(--wms-border)]">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-teal-400/90">
                      {row.epc}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[11px] font-semibold text-[var(--wms-fg)]">
                      {readerLabel(row)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-[var(--wms-muted)]">
                      {readerIp(row)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {antennaLabel(row)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-[var(--wms-muted)]">
                      {row.rssi != null ? `${row.rssi} dBm` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-[var(--wms-muted)]">
                      {row.count}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-[var(--wms-muted)]">
                      {fmtTime(row.firstSeen)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-[var(--wms-muted)]">
                      {fmtTime(row.lastSeen)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {row.sku ?? <span className="text-[var(--wms-muted)]">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                      {row.ls_system_id ?? (
                        <span className="text-[var(--wms-muted)]">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                      {desc || <span className="text-[var(--wms-muted)]">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                      {row.status ?? <span className="text-[var(--wms-muted)]">—</span>}
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
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </DataTableContainer>

      {msg ? (
        <p className="font-mono text-sm text-[var(--wms-fg)]">{msg}</p>
      ) : null}
    </div>
  );
}
