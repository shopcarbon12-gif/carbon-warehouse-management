"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  useAntennaTestStream,
  type AntennaTestRow,
} from "./use-antenna-test-stream";
import {
  ReferenceEpcsPanel,
  buildSightings,
  useReferenceEpcs,
} from "./reference-epcs-panel";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type CatalogHit = {
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  status: string;
  upc: string | null;
  vendor: string | null;
  retail_price: string | null;
  asset_id: string | null;
  sku_ls_system_id: string | null;
  location_code: string | null;
  bin_code: string | null;
};

/** Per-EPC lookup batch size — server enforces max 200 in
 *  /api/operations/transfers/lookup's zod schema. Stay under it so we
 *  never silently drop the whole batch. */
const CATALOG_LOOKUP_CHUNK = 200;

type CalibrationPoint = {
  id: string;
  distanceFt: number;
  firstReadPowerArg: number;
  referenceEpc: string;
  measuredAt: string;
};

function estimateDistance(
  points: CalibrationPoint[],
  observed: number | null,
): { feet: number | null; band: string } {
  if (observed === null) return { feet: null, band: "—" };
  if (points.length === 0) return { feet: null, band: "—" };
  const pts = [...points].sort((a, b) => a.firstReadPowerArg - b.firstReadPowerArg);
  if (pts.length === 1) {
    const p = pts[0]!;
    if (observed <= p.firstReadPowerArg) {
      return { feet: p.distanceFt, band: `≤ ${p.distanceFt.toFixed(1)} ft` };
    }
    return { feet: p.distanceFt, band: `> ${p.distanceFt.toFixed(1)} ft` };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (observed >= a.firstReadPowerArg && observed <= b.firstReadPowerArg) {
      const t = (observed - a.firstReadPowerArg) /
                Math.max(1, b.firstReadPowerArg - a.firstReadPowerArg);
      const feet = a.distanceFt + t * (b.distanceFt - a.distanceFt);
      const span = Math.abs(b.distanceFt - a.distanceFt);
      const half = Math.max(1, Math.round(span / 2));
      return { feet, band: `${feet.toFixed(1)} ft ±${half}` };
    }
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (observed < first.firstReadPowerArg) {
    return { feet: first.distanceFt, band: `≤ ${first.distanceFt.toFixed(1)} ft (extrap)` };
  }
  return { feet: last.distanceFt, band: `> ${last.distanceFt.toFixed(1)} ft (extrap)` };
}

type AntennaPickEntry = {
  readerId: string;
  readerName: string;
  readerOnline: boolean;
  readerHost: string | null;
  antennaId: string;
  antennaName: string;
  antennaNumber: number;
  defaults: {
    transmitPowerDbm: number;
    readTimeMs: number;
    cycleMode: "infinite" | "oscillating";
    tagFocus: boolean;
  } | null;
};

type Flags = {
  powerArg: number;
  readTimeMs: number;
  cycleMode: "infinite" | "oscillating";
  tagFocus: boolean;
};

type SweepConfig = {
  startPowerArg: number;
  endPowerArg: number;
  stepPowerArg: number;
  dwellMs: number;
};

const DEFAULT_FLAGS: Flags = {
  powerArg: 270,
  readTimeMs: 1000,
  cycleMode: "infinite",
  tagFocus: false,
};

const DEFAULT_SWEEP: SweepConfig = {
  startPowerArg: 100,
  endPowerArg: 330,
  stepPowerArg: 10,
  dwellMs: 1500,
};

// Distance bucket from RSSI — heuristic foot ranges. Replaced per-row with
// the calibrated estimate as soon as 2+ calibration points exist.
/** Format ms as MM:SS or H:MM:SS for run-duration display. */
function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function rssiBucket(rssi: number): { label: string; color: string; order: number } {
  if (rssi >= -55) return { label: "0–3 ft", color: "#0f9c4f", order: 0 };
  if (rssi >= -65) return { label: "3–8 ft", color: "#3fb35d", order: 1 };
  if (rssi >= -75) return { label: "8–15 ft", color: "#bcbf2c", order: 2 };
  if (rssi >= -85) return { label: "15–25 ft", color: "#dd9b2c", order: 3 };
  if (rssi >= -95) return { label: "25–45 ft", color: "#d57021", order: 4 };
  return { label: "45+ ft", color: "#b53d3d", order: 5 };
}

function buildPickList(tree: unknown): AntennaPickEntry[] {
  if (!tree || typeof tree !== "object" || !("locations" in tree)) return [];
  const out: AntennaPickEntry[] = [];
  // Walk the HardwareConfigTree shape.
  const t = tree as {
    locations: {
      zones: {
        readers: {
          id: string;
          name: string;
          status_online: boolean;
          network_address: string | null;
          antennas: {
            id: string;
            name: string;
            config: Record<string, unknown>;
          }[];
        }[];
      }[];
      unzonedReaders: {
        id: string;
        name: string;
        status_online: boolean;
        network_address: string | null;
        antennas: {
          id: string;
          name: string;
          config: Record<string, unknown>;
        }[];
      }[];
    }[];
  };
  for (const loc of t.locations ?? []) {
    const allReaders = [
      ...(loc.zones?.flatMap((z) => z.readers) ?? []),
      ...(loc.unzonedReaders ?? []),
    ];
    for (const r of allReaders) {
      for (const a of r.antennas ?? []) {
        const cfg = a.config ?? {};
        const num = Number((cfg as { antenna_number?: number }).antenna_number ?? 1);
        const txPwr = Number(
          (cfg as { transmit_power_dbm?: number }).transmit_power_dbm ?? 0,
        );
        const beh = (cfg as { behaviour?: { read_time_ms?: number; cycle_mode?: string; tag_focus?: boolean } }).behaviour;
        const defaults = txPwr > 0 || beh
          ? {
              transmitPowerDbm: txPwr || 27,
              readTimeMs: Number(beh?.read_time_ms ?? 1000),
              cycleMode:
                beh?.cycle_mode === "oscillating" ? "oscillating" : "infinite",
              tagFocus: beh?.tag_focus === true,
            } as AntennaPickEntry["defaults"]
          : null;
        out.push({
          readerId: r.id,
          readerName: r.name,
          readerOnline: r.status_online,
          readerHost: r.network_address,
          antennaId: a.id,
          antennaName: a.name,
          antennaNumber: num,
          defaults,
        });
      }
    }
  }
  return out;
}

export function AntennaTestWorkspace() {
  const tree = useSWR("/api/hardware-config", fetcher, { refreshInterval: 0 });
  const picks = useMemo(() => buildPickList(tree.data), [tree.data]);
  // When the user clicks "Test" on an antenna in /hardware_config, we
  // navigate here with `?antennaId=<uuid>` so the dropdown pre-selects
  // that antenna. Picker stays unlocked — the operator can still pick a
  // different antenna once on the page; we only set the default.
  const searchParams = useSearchParams();
  const initialAntennaIdFromUrl = searchParams?.get("antennaId") ?? "";

  const [pickedAntennaId, setPickedAntennaId] = useState<string>("");
  // Apply the URL hint once the picks list has loaded, but only if the
  // user hasn't already touched the dropdown (pickedAntennaId still empty).
  // Guarded by a ref so we don't re-apply on every picks reshuffle.
  const appliedUrlHint = useRef(false);
  useEffect(() => {
    if (appliedUrlHint.current) return;
    if (!initialAntennaIdFromUrl) return;
    if (picks.length === 0) return;
    if (picks.some((p) => p.antennaId === initialAntennaIdFromUrl)) {
      setPickedAntennaId(initialAntennaIdFromUrl);
      appliedUrlHint.current = true;
    }
  }, [initialAntennaIdFromUrl, picks]);
  const [flags, setFlags] = useState<Flags>(DEFAULT_FLAGS);
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepCfg, setSweepCfg] = useState<SweepConfig>(DEFAULT_SWEEP);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When start returns 409 the reader is already running another test
  // (different operator, different tab, or stale session). The endpoint
  // gives us the existing session id so we can offer a "take over"
  // button: stop that session, then retry start.
  const [conflictSessionId, setConflictSessionId] = useState<string | null>(null);

  // Run duration — wall-clock from "Start clicked" → "Stop clicked / session
  // ended". Tracked client-side so it survives the SSE stream lifecycle.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
  // Tick every second while live so the displayed elapsed updates.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sessionId]);

  const picked = picks.find((p) => p.antennaId === pickedAntennaId) ?? null;

  // Pre-fill knobs from saved defaults when the user picks a different antenna.
  // Tracking which antenna we last applied for so picks during a live test
  // don't clobber the operator's mid-test override.
  const lastApplied = useRef<string>("");
  useEffect(() => {
    if (!picked) return;
    if (lastApplied.current === picked.antennaId) return;
    lastApplied.current = picked.antennaId;
    if (picked.defaults) {
      setFlags({
        powerArg: Math.round(picked.defaults.transmitPowerDbm * 10),
        readTimeMs: picked.defaults.readTimeMs,
        cycleMode: picked.defaults.cycleMode,
        tagFocus: picked.defaults.tagFocus,
      });
    }
  }, [picked]);

  // Track whether current knobs differ from the saved default — controls the
  // Save button's enabled state + (saved default) / (unsaved override) badge.
  const knobsDifferFromDefault = (() => {
    if (!picked || !picked.defaults) return true; // no default = always "unsaved"
    return (
      flags.powerArg !== Math.round(picked.defaults.transmitPowerDbm * 10) ||
      flags.readTimeMs !== picked.defaults.readTimeMs ||
      flags.cycleMode !== picked.defaults.cycleMode ||
      flags.tagFocus !== picked.defaults.tagFocus
    );
  })();

  /**
   * Export the current table view to a CSV file. Honors the active sort
   * order, includes catalog enrichment + calibration band, plus a couple
   * of metadata header rows so the file is self-describing.
   */
  const exportCsv = () => {
    if (!picked) return;
    const csvEscape = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      // Quote if contains comma, quote, or newline; double-up internal quotes.
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines: string[] = [];
    // Metadata block — every row is a proper 2-column CSV line so Excel /
    // Google Sheets / LibreOffice parse them into the same column grid as
    // the data rows below. The previous `#`-prefixed style read fine in
    // a text editor but every spreadsheet treated each comment as a
    // single-cell row in column A, visually shifting all the headers and
    // making the file look "broken in columns" — verified against the
    // 2026-05-02 export the operator flagged.
    const metaRow = (key: string, value: string): string =>
      `${csvEscape(key)},${csvEscape(value)}`;
    lines.push(metaRow("Carbon WMS — Antenna Test export", ""));
    lines.push(metaRow("Reader", `${picked.readerName} (${picked.readerHost ?? ""})`));
    lines.push(metaRow("Antenna", `${picked.antennaName} (A${picked.antennaNumber})`));
    lines.push(metaRow("Captured at", new Date().toISOString()));
    lines.push(
      metaRow(
        "Run duration",
        `${runStartedAt ? fmtDuration(runDurationMs) : "—"}${
          runStartedAt
            ? ` (start: ${new Date(runStartedAt).toISOString()}${
                runEndedAt
                  ? ` → end: ${new Date(runEndedAt).toISOString()}`
                  : " — still running at export"
              })`
            : ""
        }`,
      ),
    );
    lines.push(
      metaRow(
        "Power",
        `${(flags.powerArg / 10).toFixed(1)} dBm; cycle: ${flags.cycleMode}; read_time: ${flags.readTimeMs} ms; tagfocus: ${flags.tagFocus}`,
      ),
    );
    lines.push(
      metaRow(
        "Sweep",
        sweepEnabled
          ? `${(sweepCfg.startPowerArg / 10).toFixed(1)}-${(sweepCfg.endPowerArg / 10).toFixed(1)} dBm @ ${(sweepCfg.stepPowerArg / 10).toFixed(1)} dBm step / ${sweepCfg.dwellMs} ms dwell`
          : "off",
      ),
    );
    lines.push(
      metaRow(
        "Calibration points",
        `${calibPoints.length}${
          calibPoints.length >= 2
            ? " (Distance column = interpolated feet)"
            : " (Distance column = heuristic bucket)"
        }`,
      ),
    );
    // Reference-tag pass/fail summary, when a list is loaded.
    if (referenceState.list.length > 0) {
      const sg = buildSightings(referenceState.list, rows);
      lines.push(
        metaRow(
          "Reference EPCs",
          `${sg.seen}/${sg.total} seen${
            sg.total - sg.seen > 0 ? ` · ${sg.total - sg.seen} missing` : " · ✓ all seen"
          }`,
        ),
      );
    }
    lines.push("");
    // Header row — every catalog field the lookup endpoint returns gets a
    // column. `is_reference` stays at the end for backwards-compatible
    // importers that key off the original prefix.
    lines.push(
      [
        "idx",
        "distance",
        "rssi_now_dbm",
        "best_rssi_dbm",
        "reads",
        "epc",
        "first_read_power_dbm",
        "antenna_number",
        "first_seen_iso",
        "last_seen_iso",
        "sku",
        "system_id",
        "name",
        "color",
        "size",
        "upc",
        "vendor",
        "retail_price",
        "asset_id",
        "item_status",
        "location_code",
        "bin_code",
        "is_reference",
      ]
        .map(csvEscape)
        .join(","),
    );
    // Export reflects what's on screen — filtered + sorted, in current order.
    filteredRows.forEach((row, idx) => {
      const bucket = rssiBucket(row.bestRssiDbm);
      const calibrated = estimateDistance(calibPoints, row.firstReadPowerArg);
      const distance =
        calibPoints.length >= 2 && calibrated.feet !== null
          ? calibrated.band
          : bucket.label;
      const cat = catalog.get(row.epcHex);
      lines.push(
        [
          idx + 1,
          distance,
          row.rssiDbm.toFixed(1),
          row.bestRssiDbm.toFixed(1),
          row.reads,
          row.epcHex,
          row.firstReadPowerArg !== null
            ? (row.firstReadPowerArg / 10).toFixed(1)
            : "",
          row.antennaNumber,
          new Date(row.firstSeenMs).toISOString(),
          new Date(row.lastSeenMs).toISOString(),
          cat?.sku ?? "",
          cat?.sku_ls_system_id ?? "",
          cat?.name ?? "",
          cat?.color ?? "",
          cat?.size ?? "",
          cat?.upc ?? "",
          cat?.vendor ?? "",
          cat?.retail_price ?? "",
          cat?.asset_id ?? "",
          cat?.status ?? "",
          cat?.location_code ?? "",
          cat?.bin_code ?? "",
          referenceSet.has(row.epcHex) ? "true" : "false",
        ]
          .map(csvEscape)
          .join(","),
      );
    });
    // Append a row for every reference EPC that was NEVER seen — that's the
    // export's pass/fail tail. Without this, a missing tag is just absent
    // from the export and easy to overlook downstream.
    if (referenceState.list.length > 0) {
      let tailIdx = filteredRows.length;
      for (const epc of referenceState.list) {
        if (rows.has(epc)) continue;
        tailIdx += 1;
        lines.push(
          [
            tailIdx,
            "MISSING",
            "",
            "",
            0,
            epc,
            "",
            picked.antennaNumber,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "true",
          ]
            .map(csvEscape)
            .join(","),
        );
      }
    }
    // Prepend UTF-8 BOM (﻿). Excel and most spreadsheets on Windows/Mac
    // default to Windows-1252 / Latin-1 when opening a CSV, which mojibakes
    // any non-ASCII byte (e.g. the en-dash '–' in '0–3 ft' becomes 'â€"').
    // The BOM is the universal "this file is UTF-8" hint they all honour.
    const blob = new Blob(["﻿", lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeReader = picked.readerName.replace(/[^a-z0-9]+/gi, "_");
    const a = document.createElement("a");
    a.href = url;
    a.download = `antenna-test-${safeReader}-A${picked.antennaNumber}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefaultAt, setSavedDefaultAt] = useState<number | null>(null);
  const [saveDefaultError, setSaveDefaultError] = useState<string | null>(null);
  const saveAsDefault = async () => {
    if (!picked) return;
    setSavingDefault(true);
    setSaveDefaultError(null);
    try {
      const res = await fetch(
        `/api/hardware-config/antennas/${picked.antennaId}/behaviour`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(flags),
        },
      );
      if (res.ok) {
        setSavedDefaultAt(Date.now());
        // Refetch the tree so the picker shows new defaults.
        void tree.mutate();
      } else {
        // Surface the error instead of silently swallowing. Live evidence
        // 2026-05-10: the endpoint had been 500-erroring since day one
        // because it referenced a non-existent column, but the previous
        // `if (res.ok)` pattern hid it — operators thought save succeeded.
        let msg = `Save failed (HTTP ${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch { /* body wasn't JSON */ }
        setSaveDefaultError(msg);
      }
    } catch (e) {
      setSaveDefaultError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSavingDefault(false);
    }
  };

  // Calibration points for the picked (reader, antenna). Refetched after every
  // save/delete so the distance column updates in place.
  const calibKey = picked
    ? `/api/antenna-test/calibrate?readerId=${picked.readerId}&antennaId=${picked.antennaId}`
    : null;
  const calib = useSWR<{ points: CalibrationPoint[] }>(calibKey, fetcher, {
    refreshInterval: 0,
  });
  const calibPoints = calib.data?.points ?? [];

  // Reference-EPC pass/fail tracker — operator-managed list of "tags I placed
  // in known bins" persisted per (reader, antenna). Used both for the panel
  // and for highlighting reference rows in the live table.
  const referenceState = useReferenceEpcs(picked?.readerId, picked?.antennaId);
  const referenceSet = useMemo(
    () => new Set(referenceState.list),
    [referenceState.list],
  );

  // Client-side pause: when true, the SSE stream keeps pinging and the radio
  // keeps cycling server-side, but new reads are dropped client-side so the
  // table is frozen for inspection. Resume picks up from the next read.
  const [paused, setPaused] = useState(false);

  // If the session ends server-side (e.g. expired or sweep_done), drop the
  // local sessionId so the Start button comes back. The table stays visible
  // until the operator explicitly clicks Clear.
  const { rows, stats, status, sweepProgress, clear } =
    useAntennaTestStream(sessionId, paused);
  useEffect(() => {
    if ((status === "ended" || status === "sweep_done") && sessionId) {
      setRunEndedAt(Date.now());
      setSessionId(null);
    }
  }, [status, sessionId]);

  /** True when a session just stopped/expired but rows are still on screen. */
  const showingFrozenResults =
    sessionId === null && rows.size > 0 && status !== "live" && status !== "armed";

  // Catalog enrichment: as new EPCs appear in `rows`, batch them and POST to
  // /api/catalog/enrich-epcs (session-cookie). Cache the result so we don't
  // re-fetch the same EPC. CRITICAL: this endpoint is pure-read — it does
  // NOT mutate `items`. The previous implementation hit
  // /api/operations/transfers/lookup which auto-ingested every observed EPC
  // into `items` as a side effect, silently growing inventory whenever an
  // operator ran an antenna test. See lib/server/catalog-enrich.ts for the
  // separation rationale.
  //
  // Chunked at CATALOG_LOOKUP_CHUNK (200) because the server's zod schema
  // rejects bigger payloads with 400. Pre-fix the whole first burst could
  // exceed 200 EPCs, the request would 400, the failure was silently
  // swallowed, AND those EPCs were marked as already-looked-up — so they
  // never got enriched, and every CSV export missed sku/name/color/size for
  // the first ~hundreds of rows. Now: chunk, send sequentially, on failure
  // un-mark so the next render-tick retries the failed chunk.
  const [catalog, setCatalog] = useState<Map<string, CatalogHit>>(new Map());
  const catalogRef = useRef<Map<string, CatalogHit>>(new Map());
  const lookedUpRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId) {
      catalogRef.current = new Map();
      lookedUpRef.current = new Set();
      setCatalog(new Map());
      return;
    }
    const pending: string[] = [];
    for (const epc of rows.keys()) {
      if (lookedUpRef.current.has(epc)) continue;
      lookedUpRef.current.add(epc);
      if (/^[0-9A-F]{24}$/.test(epc)) pending.push(epc);
    }
    if (pending.length === 0) return;
    void (async () => {
      // Slice into ≤200-EPC chunks; sequential keeps load on the server low
      // and lets the table populate progressively as each chunk lands.
      for (let i = 0; i < pending.length; i += CATALOG_LOOKUP_CHUNK) {
        const chunk = pending.slice(i, i + CATALOG_LOOKUP_CHUNK);
        try {
          const res = await fetch("/api/catalog/enrich-epcs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ epcs: chunk }),
          });
          if (!res.ok) {
            // Un-mark so the next render-tick (typically <100ms away while
            // reads are flowing) retries this chunk.
            for (const e of chunk) lookedUpRef.current.delete(e);
            continue;
          }
          const data = (await res.json()) as {
            rows?: {
              epc: string;
              sku: string;
              name: string | null;
              color: string | null;
              size: string | null;
              status: string;
              upc: string | null;
              vendor: string | null;
              retail_price: string | null;
              asset_id: string | null;
              sku_ls_system_id: string | null;
              location_code: string | null;
              bin_code: string | null;
            }[];
          };
          for (const row of data.rows ?? []) {
            catalogRef.current.set(row.epc.toUpperCase(), {
              sku: row.sku,
              name: row.name,
              color: row.color,
              size: row.size,
              status: row.status,
              upc: row.upc,
              vendor: row.vendor,
              retail_price: row.retail_price,
              asset_id: row.asset_id,
              sku_ls_system_id: row.sku_ls_system_id,
              location_code: row.location_code,
              bin_code: row.bin_code,
            });
          }
          setCatalog(new Map(catalogRef.current));
        } catch {
          // Network failure / aborted — un-mark and retry on next tick.
          for (const e of chunk) lookedUpRef.current.delete(e);
        }
      }
    })();
  }, [rows, sessionId]);

  const startScan = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setConflictSessionId(null);
    try {
      const res = await fetch("/api/antenna-test/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          antennaId: picked.antennaId,
          flags,
          sweep: sweepEnabled ? sweepCfg : null,
        }),
      });
      const json = (await res.json()) as {
        sessionId?: string;
        error?: string;
        existingSessionId?: string;
      };
      if (!res.ok || !json.sessionId) {
        setError(json.error ?? `HTTP ${res.status}`);
        // 409 from /start carries the existing sessionId so the operator
        // can take it over without leaving the page or chasing whichever
        // tab/operator started it.
        if (res.status === 409 && json.existingSessionId) {
          setConflictSessionId(json.existingSessionId);
        }
        return;
      }
      setSessionId(json.sessionId);
      setRunStartedAt(Date.now());
      setRunEndedAt(null);
      setPaused(false);
    } finally {
      setBusy(false);
    }
  };

  // Stop whichever in-flight session is on this reader (from a 409 on
  // /start) and immediately try to start ours. The /stop endpoint is
  // tenant-scoped — it'll succeed even if the original session was
  // started by another operator on this tenant. If /stop returns 404
  // (session already ended in the meantime) we still try /start.
  const takeoverAndStart = async () => {
    if (!conflictSessionId) return;
    setBusy(true);
    try {
      await fetch("/api/antenna-test/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: conflictSessionId }),
      }).catch(() => {
        /* ignore — try to start anyway */
      });
      setConflictSessionId(null);
    } finally {
      setBusy(false);
    }
    // Brief pause so the supervisor sees the "ended" lifecycle and
    // releases its slot before we ask it to enter test mode again.
    await new Promise((r) => setTimeout(r, 250));
    await startScan();
  };

  const stopScan = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await fetch("/api/antenna-test/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } finally {
      setBusy(false);
      setRunEndedAt(Date.now());
      setSessionId(null);
    }
  };

  // Live patch — power slider during an active scan.
  useEffect(() => {
    if (!sessionId) return;
    const handle = setTimeout(() => {
      void fetch("/api/antenna-test/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, flags }),
      });
    }, 500);
    return () => clearTimeout(handle);
  }, [flags, sessionId]);

  // Sort state — click any header to toggle. Default = distance asc (closest
  // tags at the top), matching the original behaviour.
  type SortKey =
    | "distance"
    | "rssi"
    | "best"
    | "reads"
    | "epc"
    | "firstPower"
    | "sku"
    | "desc";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("distance");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const onHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible default direction per column type.
      const numericClosestFirst = key === "distance" || key === "firstPower";
      const numericLargestFirst = key === "rssi" || key === "best" || key === "reads";
      setSortDir(numericClosestFirst ? "asc" : numericLargestFirst ? "desc" : "asc");
    }
  };

  // Sortable comparator. For each column we define one canonical comparator
  // (always "smaller / earlier / lesser first"); the dir multiplier flips it.
  const sortedRows = useMemo<AntennaTestRow[]>(() => {
    const arr = Array.from(rows.values());
    const dir = sortDir === "asc" ? 1 : -1;
    const cmpStr = (x: string, y: string) => x.localeCompare(y);
    const cmpNum = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
    const nullsLast = (x: number | null, y: number | null) => {
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return cmpNum(x, y);
    };
    arr.sort((a, b) => {
      let c = 0;
      switch (sortKey) {
        case "distance":
          // "Closer" = higher (less-negative) RSSI. Asc = closer first
          // (intuitive for "0–3 ft → 45+ ft"), so flip the natural cmp.
          c = -cmpNum(a.bestRssiDbm, b.bestRssiDbm);
          break;
        case "rssi":
          c = cmpNum(a.rssiDbm, b.rssiDbm);
          break;
        case "best":
          c = cmpNum(a.bestRssiDbm, b.bestRssiDbm);
          break;
        case "reads":
          c = cmpNum(a.reads, b.reads);
          break;
        case "epc":
          c = cmpStr(a.epcHex, b.epcHex);
          break;
        case "firstPower":
          c = nullsLast(a.firstReadPowerArg, b.firstReadPowerArg);
          break;
        case "sku": {
          const sa = catalog.get(a.epcHex)?.sku ?? "";
          const sb = catalog.get(b.epcHex)?.sku ?? "";
          c = cmpStr(sa, sb);
          break;
        }
        case "desc": {
          const ca = catalog.get(a.epcHex);
          const cb = catalog.get(b.epcHex);
          const da = ca ? [ca.name, ca.color, ca.size].filter(Boolean).join(" ") : "";
          const db = cb ? [cb.name, cb.color, cb.size].filter(Boolean).join(" ") : "";
          c = cmpStr(da, db);
          break;
        }
      }
      if (c === 0) c = -cmpNum(a.bestRssiDbm, b.bestRssiDbm); // tie-breaker
      return c * dir;
    });
    return arr;
  }, [rows, sortKey, sortDir, catalog]);

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  // Free-form filter — case-insensitive substring match against everything
  // visible on a row. Empty query passes all rows. Scoped per-render against
  // sortedRows so sort + filter compose cleanly.
  const [filterQuery, setFilterQuery] = useState("");
  const filteredRows = useMemo<AntennaTestRow[]>(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return sortedRows;
    return sortedRows.filter((row) => {
      const cat = catalog.get(row.epcHex);
      const bucket = rssiBucket(row.bestRssiDbm).label;
      const haystack = [
        row.epcHex,
        bucket,
        cat?.sku,
        cat?.sku_ls_system_id,
        cat?.name,
        cat?.color,
        cat?.size,
        cat?.upc,
        cat?.vendor,
        cat?.retail_price,
        cat?.status,
        cat?.location_code,
        cat?.bin_code,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedRows, filterQuery, catalog]);

  // Calibration save flow — operator types the distance for the row whose
  // EPC they want to save as a reference. We POST to /calibrate, then
  // refetch points so the distance column updates.
  const [calibDraft, setCalibDraft] = useState<{ epc: string; distanceFt: string } | null>(null);
  const submitCalibration = async () => {
    if (!calibDraft || !picked) return;
    const row = rows.get(calibDraft.epc);
    if (!row || row.firstReadPowerArg === null) return;
    const distance = Number(calibDraft.distanceFt);
    if (!Number.isFinite(distance) || distance <= 0) return;
    await fetch("/api/antenna-test/calibrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        readerId: picked.readerId,
        antennaId: picked.antennaId,
        distanceFt: distance,
        firstReadPowerArg: row.firstReadPowerArg,
        referenceEpc: row.epcHex,
      }),
    });
    setCalibDraft(null);
    void calib.mutate();
  };
  const deleteCalibrationPoint = async (id: string) => {
    await fetch(`/api/antenna-test/calibrate/${id}`, { method: "DELETE" });
    void calib.mutate();
  };

  const isLive = sessionId !== null;
  // Run duration: live = "now − Start"; frozen = "End − Start"; idle/empty = 0.
  const runDurationMs = runStartedAt
    ? (runEndedAt ?? Date.now()) - runStartedAt
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Picker + knobs */}
      <section className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)] p-4">
        <header className="mb-3 flex items-baseline justify-between gap-3 border-b border-[var(--wms-border)] pb-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
              Configuration
            </h3>
            <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--wms-muted)]">
              radio knobs · sweep · controls
            </span>
          </div>
          <StatusPill
            status={paused && isLive ? "paused" : status}
            isLive={isLive && !paused}
          />
        </header>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
              Reader · Antenna
            </label>
            <select
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 text-sm"
              value={pickedAntennaId}
              onChange={(e) => setPickedAntennaId(e.target.value)}
              disabled={isLive}
            >
              <option value="">— select an antenna —</option>
              {picks.map((p) => (
                <option key={p.antennaId} value={p.antennaId}>
                  {p.readerName}
                  {p.readerHost ? ` (${p.readerHost})` : ""} · {p.antennaName} (A
                  {p.antennaNumber})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="block text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
              Power: {(flags.powerArg / 10).toFixed(1)} dBm (raw {flags.powerArg})
            </label>
            <input
              type="range"
              min={100}
              max={330}
              step={5}
              value={flags.powerArg}
              onChange={(e) =>
                setFlags((f) => ({ ...f, powerArg: Number(e.target.value) }))
              }
              className="mt-2 w-full"
            />
            <div className="font-mono text-[10px] text-[var(--wms-muted)]">
              10.0 dBm — 33.0 dBm range
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
              Read time (ms)
            </label>
            <input
              type="number"
              min={250}
              max={5000}
              step={250}
              value={flags.readTimeMs}
              onChange={(e) =>
                setFlags((f) => ({ ...f, readTimeMs: Number(e.target.value) }))
              }
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
              Cycle mode
            </label>
            <div className="mt-1 flex gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="cycle"
                  checked={flags.cycleMode === "infinite"}
                  onChange={() => setFlags((f) => ({ ...f, cycleMode: "infinite" }))}
                />
                infinite
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="cycle"
                  checked={flags.cycleMode === "oscillating"}
                  onChange={() =>
                    setFlags((f) => ({ ...f, cycleMode: "oscillating" }))
                  }
                />
                oscillating
              </label>
            </div>
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
              Tag focus
            </label>
            <label className="mt-2 flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={flags.tagFocus}
                onChange={(e) =>
                  setFlags((f) => ({ ...f, tagFocus: e.target.checked }))
                }
              />
              enable
            </label>
          </div>
        </div>

        {/* Sweep mode panel */}
        <div className="mt-4 rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={sweepEnabled}
              onChange={(e) => setSweepEnabled(e.target.checked)}
              disabled={isLive}
            />
            <span>Sweep mode — auto-walk power from low to high</span>
          </label>
          <p className="mt-1 ml-6 font-mono text-[10px] text-[var(--wms-muted)]">
            Each tag&apos;s <strong>first-read power</strong> column shows the lowest dBm
            at which it appeared — that&apos;s the cleanest distance proxy you can get
            without calibration.
          </p>
          {sweepEnabled && (
            <div className="mt-3 ml-6 grid gap-3 sm:grid-cols-4">
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wide text-[var(--wms-muted)]">
                  Start (dBm)
                </label>
                <input
                  type="number"
                  min={10}
                  max={33}
                  step={1}
                  value={sweepCfg.startPowerArg / 10}
                  onChange={(e) =>
                    setSweepCfg((s) => ({
                      ...s,
                      startPowerArg: Math.round(Number(e.target.value) * 10),
                    }))
                  }
                  disabled={isLive}
                  className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-card)] px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wide text-[var(--wms-muted)]">
                  End (dBm)
                </label>
                <input
                  type="number"
                  min={10}
                  max={33}
                  step={1}
                  value={sweepCfg.endPowerArg / 10}
                  onChange={(e) =>
                    setSweepCfg((s) => ({
                      ...s,
                      endPowerArg: Math.round(Number(e.target.value) * 10),
                    }))
                  }
                  disabled={isLive}
                  className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-card)] px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wide text-[var(--wms-muted)]">
                  Step (dBm)
                </label>
                <input
                  type="number"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={sweepCfg.stepPowerArg / 10}
                  onChange={(e) =>
                    setSweepCfg((s) => ({
                      ...s,
                      stepPowerArg: Math.max(
                        1,
                        Math.round(Number(e.target.value) * 10),
                      ),
                    }))
                  }
                  disabled={isLive}
                  className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-card)] px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wide text-[var(--wms-muted)]">
                  Dwell (ms/step)
                </label>
                <input
                  type="number"
                  min={500}
                  max={10000}
                  step={500}
                  value={sweepCfg.dwellMs}
                  onChange={(e) =>
                    setSweepCfg((s) => ({ ...s, dwellMs: Number(e.target.value) }))
                  }
                  disabled={isLive}
                  className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-card)] px-2 py-1 text-sm"
                />
              </div>
            </div>
          )}
          {sweepEnabled && (
            <p className="mt-2 ml-6 font-mono text-[10px] text-[var(--wms-muted)]">
              Total ramp:{" "}
              {Math.max(
                1,
                Math.ceil(
                  (sweepCfg.endPowerArg - sweepCfg.startPowerArg) /
                    sweepCfg.stepPowerArg,
                ) + 1,
              )}{" "}
              steps × {(sweepCfg.dwellMs / 1000).toFixed(1)} s each ≈{" "}
              {Math.round(
                (Math.max(
                  1,
                  Math.ceil(
                    (sweepCfg.endPowerArg - sweepCfg.startPowerArg) /
                      sweepCfg.stepPowerArg,
                  ) + 1,
                ) *
                  sweepCfg.dwellMs) /
                  1000,
              )}{" "}
              s total.
            </p>
          )}
          {sweepProgress && isLive && (
            <div className="mt-2 ml-6 font-mono text-[11px] text-[var(--wms-fg)]">
              ◔ Sweep step {sweepProgress.stepIndex + 1}/{sweepProgress.totalSteps} —
              currently at{" "}
              <strong>{(sweepProgress.currentPowerArg / 10).toFixed(1)} dBm</strong>
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {!isLive ? (
            <button
              onClick={startScan}
              disabled={busy || !picked}
              className="rounded bg-[var(--wms-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Starting…" : "▶ Start scan"}
            </button>
          ) : (
            <>
              <button
                onClick={stopScan}
                disabled={busy}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "Stopping…" : "■ Stop"}
              </button>
              <button
                onClick={() => setPaused((p) => !p)}
                title={
                  paused
                    ? "Resume: new reads start updating the table again. Reads received while paused were dropped client-side."
                    : "Pause: freeze the table client-side. Radio keeps cycling on the reader; reads received while paused are not added to the table."
                }
                className={`rounded px-4 py-2 text-sm font-medium ${
                  paused
                    ? "bg-emerald-600 text-white hover:bg-emerald-500"
                    : "border border-[var(--wms-border)] bg-[var(--wms-bg)] text-[var(--wms-fg)] hover:bg-[var(--wms-card)]"
                }`}
              >
                {paused ? "▶ Resume" : "⏸ Pause"}
              </button>
            </>
          )}
          {showingFrozenResults && (
            <button
              onClick={clear}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 text-sm hover:bg-[var(--wms-card)]"
              title="Wipe the displayed results so the next Start scan begins fresh."
            >
              ⌫ Clear session
            </button>
          )}
          {picked && rows.size > 0 && (
            <button
              onClick={exportCsv}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 text-sm hover:bg-[var(--wms-card)]"
              title="Download the current table view as a CSV file (current sort order; metadata header rows included)."
            >
              ↓ Export CSV
            </button>
          )}
          {picked && (
            <button
              onClick={saveAsDefault}
              disabled={savingDefault || !knobsDifferFromDefault}
              title="Save these radio knobs as the antenna's default — used by Transfer Out, Dashboard, and any other page that uses the normal scan."
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 text-sm hover:bg-[var(--wms-card)] disabled:opacity-40"
            >
              {savingDefault
                ? "Saving…"
                : savedDefaultAt && Date.now() - savedDefaultAt < 5000
                  ? "✓ Saved"
                  : "💾 Save as antenna default"}
            </button>
          )}
          {saveDefaultError && (
            <span className="font-mono text-xs text-red-500/90">
              {saveDefaultError}
            </span>
          )}
          {picked && (
            <span className="font-mono text-[10px] text-[var(--wms-muted)]">
              {!picked.defaults
                ? "(no saved default)"
                : knobsDifferFromDefault
                  ? "(unsaved override)"
                  : "(saved default)"}
            </span>
          )}
          {error && (
            <span className="flex items-center gap-2 font-mono text-xs text-red-600">
              <span>{error}</span>
              {conflictSessionId && (
                <button
                  type="button"
                  onClick={() => void takeoverAndStart()}
                  disabled={busy}
                  className="rounded border border-red-600 px-2 py-0.5 font-mono text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Stop other & start here
                </button>
              )}
            </span>
          )}
        </div>

        {/* Stats strip — visible whenever there's anything to report. */}
        {(runStartedAt !== null || isLive || stats.totalReads > 0) && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2">
            <Stat label={isLive ? "running" : "ran"} value={fmtDuration(runDurationMs)} mono />
            <Stat label="unique EPCs" value={stats.uniqueEpcs.toLocaleString()} />
            <Stat label="total reads" value={stats.totalReads.toLocaleString()} />
            <Stat
              label="dropped"
              value={stats.droppedBadCrc.toLocaleString()}
              tone={stats.droppedBadCrc > 0 ? "warn" : "muted"}
            />
            {sweepProgress && isLive && (
              <Stat
                label="sweep step"
                value={`${sweepProgress.stepIndex + 1}/${sweepProgress.totalSteps} @ ${(sweepProgress.currentPowerArg / 10).toFixed(1)} dBm`}
                mono
              />
            )}
          </div>
        )}
      </section>

      {/* Calibration panel — only relevant when an antenna is picked */}
      {picked && (
        <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)] p-4">
          <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
            Calibration · {picked.readerName} / {picked.antennaName}
          </h3>
          <p className="mt-0.5 font-mono text-[10px] text-[var(--wms-muted)]">
            Place a reference tag at a known distance, run a sweep, then click{" "}
            <strong>Save as point</strong> on the row matching that tag. With 2+ points
            the Distance column starts showing real feet instead of the heuristic bucket.
          </p>
          {calibPoints.length === 0 ? (
            <p className="mt-3 font-mono text-[11px] text-[var(--wms-muted)]">
              No calibration points yet — distance shows the heuristic bucket.
            </p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
                <tr>
                  <th className="px-2 py-1 text-right">Distance (ft)</th>
                  <th className="px-2 py-1 text-right">First-read power</th>
                  <th className="px-2 py-1 text-left">Reference EPC</th>
                  <th className="px-2 py-1 text-left">Measured</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {[...calibPoints]
                  .sort((a, b) => a.distanceFt - b.distanceFt)
                  .map((p) => (
                    <tr key={p.id} className="border-t border-[var(--wms-border)]">
                      <td className="px-2 py-1 text-right font-mono text-[11px]">
                        {p.distanceFt.toFixed(1)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-[11px]">
                        {(p.firstReadPowerArg / 10).toFixed(1)} dBm
                      </td>
                      <td className="px-2 py-1 font-mono text-[11px]">
                        {p.referenceEpc}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-[var(--wms-muted)]">
                        {new Date(p.measuredAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          onClick={() => deleteCalibrationPoint(p.id)}
                          className="text-[10px] text-red-600 hover:underline"
                        >
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Reference EPCs — operator-managed pass/fail list */}
      <ReferenceEpcsPanel
        state={referenceState}
        rows={rows}
        isLive={isLive}
        hasAntennaPicked={picked !== null}
      />

      {/* Filter bar — case-insensitive substring across every visible field.
          Keeps the live table usable when 1000+ EPCs are streaming in. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)] px-3 py-2">
        <input
          type="search"
          placeholder="Filter — EPC, SKU, system ID, name, color, size, UPC, vendor, status, location, bin, distance bucket…"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-1.5 font-mono text-xs"
        />
        {filterQuery && (
          <button
            onClick={() => setFilterQuery("")}
            className="rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-[var(--wms-muted)] hover:bg-[var(--wms-card)]"
            title="Clear filter"
          >
            × clear
          </button>
        )}
        {filterQuery.trim() ? (
          <span className="font-mono text-[10px] text-[var(--wms-muted)]">
            showing <strong className="text-[var(--wms-fg)]">{filteredRows.length}</strong>{" "}
            of <strong className="text-[var(--wms-fg)]">{sortedRows.length}</strong>
          </span>
        ) : sortedRows.length > 0 ? (
          <span className="font-mono text-[10px] text-[var(--wms-muted)]">
            <strong className="text-[var(--wms-fg)]">{sortedRows.length}</strong> row
            {sortedRows.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {/* Live table — overflow-x-auto so the page itself doesn't widen, only
          the table region scrolls sideways. table-auto + min-w-max + per-cell
          whitespace-nowrap means columns auto-size to their content — no
          truncation, no wrap, just scroll if it overflows. */}
      <div className="overflow-x-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)]">
        <table className="min-w-max table-auto text-sm">
          <thead className="bg-[var(--wms-bg)] text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 text-right">#</th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("distance")}
              >
                Distance{sortIndicator("distance")}
              </th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("rssi")}
              >
                RSSI now{sortIndicator("rssi")}
              </th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("best")}
              >
                Best{sortIndicator("best")}
              </th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-right hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("reads")}
              >
                Reads{sortIndicator("reads")}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Sparkline (5 s)</th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("epc")}
              >
                EPC{sortIndicator("epc")}
              </th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("firstPower")}
              >
                First-read power{sortIndicator("firstPower")}
              </th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("sku")}
              >
                Custom SKU{sortIndicator("sku")}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left">System ID</th>
              <th
                className="whitespace-nowrap cursor-pointer select-none px-3 py-2 text-left hover:text-[var(--wms-fg)]"
                onClick={() => onHeaderClick("desc")}
              >
                Description (name · color · size){sortIndicator("desc")}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left">UPC</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Vendor</th>
              <th className="whitespace-nowrap px-3 py-2 text-right">Price</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Item status</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Loc · Bin</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Calibrate</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={17}
                  className="px-3 py-8 text-center text-xs text-[var(--wms-muted)]"
                >
                  {filterQuery.trim()
                    ? `No rows match "${filterQuery.trim()}". Clear the filter to see all ${sortedRows.length} row${sortedRows.length === 1 ? "" : "s"}.`
                    : isLive
                      ? "Waiting for first read…"
                      : "Pick an antenna and click Start scan."}
                </td>
              </tr>
            )}
            {filteredRows.map((row, idx) => {
              const bucket = rssiBucket(row.bestRssiDbm);
              const cat = catalog.get(row.epcHex);
              const desc = cat
                ? [cat.name, cat.color, cat.size].filter((x) => x && x.trim()).join(" · ")
                : "";
              const calibrated = estimateDistance(calibPoints, row.firstReadPowerArg);
              const showCalibrated = calibPoints.length >= 2 && calibrated.feet !== null;
              const isReference = referenceSet.has(row.epcHex);
              return (
                <tr
                  key={row.epcHex}
                  className="border-t border-[var(--wms-border)] hover:bg-[var(--wms-hover,rgba(0,0,0,0.02))]"
                  style={
                    isReference ? { background: "rgba(15, 156, 79, 0.08)" } : undefined
                  }
                >
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[10px] text-[var(--wms-muted)]">
                    {idx + 1}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {showCalibrated ? (
                      <span className="font-mono text-[11px] font-semibold text-[var(--wms-fg)]">
                        {calibrated.band}
                      </span>
                    ) : (
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                        style={{ background: bucket.color }}
                      >
                        {bucket.label}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {row.rssiDbm.toFixed(1)} dBm
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {row.bestRssiDbm.toFixed(1)} dBm
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px]">
                    {row.reads}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <Sparkline points={row.spark} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {isReference && (
                      <span
                        className="mr-1 inline-block align-middle"
                        title="Reference EPC — listed in the pass/fail tracker"
                        style={{ color: "#0f9c4f" }}
                      >
                        ★
                      </span>
                    )}
                    {row.epcHex}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {row.firstReadPowerArg !== null ? (
                      `${(row.firstReadPowerArg / 10).toFixed(1)} dBm`
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {cat?.sku ?? <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {cat?.sku_ls_system_id ?? <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                    {desc || <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {cat?.upc ?? <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                    {cat?.vendor ?? <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px]">
                    {cat?.retail_price ? (
                      `$${Number(cat.retail_price).toFixed(2)}`
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[11px]">
                    {cat?.status ? (
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white ${
                          cat.status === "in-stock"
                            ? "bg-emerald-600"
                            : cat.status === "tag_killed"
                              ? "bg-red-600"
                              : "bg-slate-500"
                        }`}
                      >
                        {cat.status}
                      </span>
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
                    {cat?.location_code ? (
                      <>
                        {cat.location_code}
                        {cat.bin_code ? ` · ${cat.bin_code}` : ""}
                      </>
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {row.firstReadPowerArg !== null && picked ? (
                      calibDraft && calibDraft.epc === row.epcHex ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            type="number"
                            step={0.5}
                            min={0.1}
                            placeholder="ft"
                            value={calibDraft.distanceFt}
                            onChange={(e) =>
                              setCalibDraft({
                                epc: row.epcHex,
                                distanceFt: e.target.value,
                              })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void submitCalibration();
                              if (e.key === "Escape") setCalibDraft(null);
                            }}
                            className="w-14 rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-1 py-0.5 text-[11px]"
                          />
                          <button
                            onClick={() => void submitCalibration()}
                            className="text-[10px] text-green-700 hover:underline"
                          >
                            save
                          </button>
                          <button
                            onClick={() => setCalibDraft(null)}
                            className="text-[10px] text-[var(--wms-muted)] hover:underline"
                          >
                            cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() =>
                            setCalibDraft({ epc: row.epcHex, distanceFt: "" })
                          }
                          className="text-[10px] text-blue-700 hover:underline"
                        >
                          save as point
                        </button>
                      )
                    ) : (
                      <span className="text-[10px] text-[var(--wms-muted)]">
                        {row.firstReadPowerArg === null ? "(sweep first)" : "—"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {isLive && (
          <div className="border-t border-[var(--wms-border)] px-3 py-2 font-mono text-[10px] text-[var(--wms-muted)]">
            Reading antenna {picked?.antennaName ?? "?"} on {picked?.readerName ?? "?"}{" "}
            · power {(flags.powerArg / 10).toFixed(1)} dBm · cycle {flags.cycleMode}
            {flags.tagFocus ? " · tagfocus" : ""} · running{" "}
            {fmtDuration(runDurationMs)}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status, isLive }: { status: string; isLive: boolean }) {
  const tone = (() => {
    if (isLive) return { bg: "#0f9c4f", fg: "#fff", dot: "#a7f3a7" };
    if (status === "paused") return { bg: "#b45309", fg: "#fff", dot: "#fde68a" };
    if (status === "armed") return { bg: "#b45309", fg: "#fff", dot: "#fde68a" };
    if (status === "ended" || status === "sweep_done")
      return { bg: "#475569", fg: "#fff", dot: "#cbd5e1" };
    return { bg: "var(--wms-bg)", fg: "var(--wms-muted)", dot: "var(--wms-muted)" };
  })();
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide"
      style={{ background: tone.bg, color: tone.fg }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: tone.dot,
          animation: isLive ? "wms-status-pulse 1.4s ease-in-out infinite" : undefined,
        }}
      />
      {status}
      <style>{`@keyframes wms-status-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
    </span>
  );
}

function Stat({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "warn" | "muted";
}) {
  const valueColor =
    tone === "warn" ? "#b45309" : tone === "muted" ? "var(--wms-muted)" : "var(--wms-fg)";
  return (
    <div className="flex flex-col leading-tight">
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--wms-muted)]">
        {label}
      </span>
      <span
        className={`text-sm font-semibold ${mono ? "font-mono" : ""}`}
        style={{ color: valueColor }}
      >
        {value}
      </span>
    </div>
  );
}

function Sparkline({ points }: { points: { ms: number; rssi: number }[] }) {
  if (points.length < 2) {
    return <span className="font-mono text-[10px] text-[var(--wms-muted)]">—</span>;
  }
  const W = 80;
  const H = 18;
  const minMs = points[0]!.ms;
  const maxMs = points[points.length - 1]!.ms;
  const span = Math.max(1, maxMs - minMs);
  // Fixed RSSI range so vertical position is comparable across rows.
  const RMIN = -100;
  const RMAX = -30;
  const y = (rssi: number) =>
    H - ((Math.max(RMIN, Math.min(RMAX, rssi)) - RMIN) / (RMAX - RMIN)) * H;
  const x = (ms: number) => ((ms - minMs) / span) * W;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ms).toFixed(1)},${y(p.rssi).toFixed(1)}`)
    .join(" ");
  const lastRssi = points[points.length - 1]!.rssi;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block">
      <path d={path} fill="none" stroke="#3b82f6" strokeWidth={1.25} />
      <circle cx={x(maxMs)} cy={y(lastRssi)} r={1.6} fill="#3b82f6" />
    </svg>
  );
}
