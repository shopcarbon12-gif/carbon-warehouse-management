"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  useAntennaTestStream,
  type AntennaTestRow,
} from "./use-antenna-test-stream";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type CatalogHit = {
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  status: string;
};

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

// Distance bucket from RSSI — heuristic, replaced with calibrated curve in
// Phase 3.
function rssiBucket(rssi: number): { label: string; color: string; order: number } {
  if (rssi >= -55) return { label: "very close", color: "#0f9c4f", order: 0 };
  if (rssi >= -65) return { label: "close", color: "#3fb35d", order: 1 };
  if (rssi >= -75) return { label: "near", color: "#bcbf2c", order: 2 };
  if (rssi >= -85) return { label: "mid", color: "#dd9b2c", order: 3 };
  if (rssi >= -95) return { label: "far", color: "#d57021", order: 4 };
  return { label: "fringe", color: "#b53d3d", order: 5 };
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
        out.push({
          readerId: r.id,
          readerName: r.name,
          readerOnline: r.status_online,
          readerHost: r.network_address,
          antennaId: a.id,
          antennaName: a.name,
          antennaNumber: num,
        });
      }
    }
  }
  return out;
}

export function AntennaTestWorkspace() {
  const tree = useSWR("/api/hardware-config", fetcher, { refreshInterval: 0 });
  const picks = useMemo(() => buildPickList(tree.data), [tree.data]);

  const [pickedAntennaId, setPickedAntennaId] = useState<string>("");
  const [flags, setFlags] = useState<Flags>(DEFAULT_FLAGS);
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepCfg, setSweepCfg] = useState<SweepConfig>(DEFAULT_SWEEP);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = picks.find((p) => p.antennaId === pickedAntennaId) ?? null;

  // Calibration points for the picked (reader, antenna). Refetched after every
  // save/delete so the distance column updates in place.
  const calibKey = picked
    ? `/api/antenna-test/calibrate?readerId=${picked.readerId}&antennaId=${picked.antennaId}`
    : null;
  const calib = useSWR<{ points: CalibrationPoint[] }>(calibKey, fetcher, {
    refreshInterval: 0,
  });
  const calibPoints = calib.data?.points ?? [];

  // If the session ends server-side (e.g. expired), drop the local sessionId
  // so the table resets and the Start button comes back.
  const { rows, stats, status, sweepProgress } = useAntennaTestStream(sessionId);
  useEffect(() => {
    if (status === "ended" && sessionId) setSessionId(null);
  }, [status, sessionId]);

  // Catalog enrichment: as new EPCs appear in `rows`, batch them and POST to
  // /api/operations/transfers/lookup (session-cookie). Cache the result so we
  // don't re-fetch the same EPC. Same pattern used by the dashboard live-scan
  // tile — auto-ingests previously-unknown EPCs and links them to a custom_sku.
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
    // Find EPCs in current rows that we haven't tried to look up yet.
    const pending: string[] = [];
    for (const epc of rows.keys()) {
      if (lookedUpRef.current.has(epc)) continue;
      lookedUpRef.current.add(epc);
      // Lookup endpoint requires 24-char hex; sweep mode shorter EPCs are skipped.
      if (/^[0-9A-F]{24}$/.test(epc)) pending.push(epc);
    }
    if (pending.length === 0) return;
    // Fire-and-forget; merge response into catalog Map.
    void (async () => {
      try {
        const res = await fetch("/api/operations/transfers/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ epcs: pending }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          rows?: { epc: string; sku: string; name: string | null; color: string | null; size: string | null; status: string }[];
        };
        for (const row of data.rows ?? []) {
          catalogRef.current.set(row.epc.toUpperCase(), {
            sku: row.sku,
            name: row.name,
            color: row.color,
            size: row.size,
            status: row.status,
          });
        }
        setCatalog(new Map(catalogRef.current));
      } catch {
        /* ignore — operator will see "—" cells; we'll retry on next batch */
      }
    })();
  }, [rows, sessionId]);

  const startScan = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
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
      const json = (await res.json()) as { sessionId?: string; error?: string };
      if (!res.ok || !json.sessionId) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setSessionId(json.sessionId);
    } finally {
      setBusy(false);
    }
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

  // Sort rows by best RSSI (closest first), then by total reads.
  const sortedRows = useMemo<AntennaTestRow[]>(() => {
    const arr = Array.from(rows.values());
    arr.sort((a, b) => {
      if (b.bestRssiDbm !== a.bestRssiDbm) return b.bestRssiDbm - a.bestRssiDbm;
      return b.reads - a.reads;
    });
    return arr;
  }, [rows]);

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
  const elapsedMs = sessionId
    ? Math.max(0, Date.now() - (sortedRows[0]?.firstSeenMs ?? Date.now()))
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Picker + knobs */}
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)] p-4">
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
            Each tag's <strong>first-read power</strong> column shows the lowest dBm
            at which it appeared — that's the cleanest distance proxy you can get
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

        <div className="mt-5 flex items-center gap-3">
          {!isLive ? (
            <button
              onClick={startScan}
              disabled={busy || !picked}
              className="rounded bg-[var(--wms-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Starting…" : "▶ Start scan"}
            </button>
          ) : (
            <button
              onClick={stopScan}
              disabled={busy}
              className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Stopping…" : "■ Stop"}
            </button>
          )}
          <span className="font-mono text-xs text-[var(--wms-muted)]">
            status: <strong className="text-[var(--wms-fg)]">{status}</strong>
            {isLive && (
              <>
                {" · "}
                <strong className="text-[var(--wms-fg)]">{stats.uniqueEpcs}</strong>{" "}
                unique ·{" "}
                <strong className="text-[var(--wms-fg)]">{stats.totalReads}</strong>{" "}
                reads · dropped:{" "}
                <strong className="text-[var(--wms-fg)]">{stats.droppedBadCrc}</strong>
              </>
            )}
          </span>
          {error && (
            <span className="font-mono text-xs text-red-600">{error}</span>
          )}
        </div>
      </div>

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

      {/* Live table */}
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--wms-bg)] text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-right">#</th>
              <th className="px-3 py-2 text-left">Distance</th>
              <th className="px-3 py-2 text-left">RSSI now</th>
              <th className="px-3 py-2 text-left">Best</th>
              <th className="px-3 py-2 text-right">Reads</th>
              <th className="px-3 py-2 text-left">Sparkline (5 s)</th>
              <th className="px-3 py-2 text-left">EPC</th>
              <th className="px-3 py-2 text-left">First-read power</th>
              <th className="px-3 py-2 text-left">Custom SKU</th>
              <th className="px-3 py-2 text-left">Description (name · color · size)</th>
              <th className="px-3 py-2 text-left">Calibrate</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-xs text-[var(--wms-muted)]"
                >
                  {isLive
                    ? "Waiting for first read…"
                    : "Pick an antenna and click Start scan."}
                </td>
              </tr>
            )}
            {sortedRows.map((row, idx) => {
              const bucket = rssiBucket(row.bestRssiDbm);
              const cat = catalog.get(row.epcHex);
              const desc = cat
                ? [cat.name, cat.color, cat.size].filter((x) => x && x.trim()).join(" · ")
                : "";
              const calibrated = estimateDistance(calibPoints, row.firstReadPowerArg);
              const showCalibrated = calibPoints.length >= 2 && calibrated.feet !== null;
              return (
                <tr
                  key={row.epcHex}
                  className="border-t border-[var(--wms-border)] hover:bg-[var(--wms-hover,rgba(0,0,0,0.02))]"
                >
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] text-[var(--wms-muted)]">
                    {idx + 1}
                  </td>
                  <td className="px-3 py-1.5">
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
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    {row.rssiDbm.toFixed(1)} dBm
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    {row.bestRssiDbm.toFixed(1)} dBm
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                    {row.reads}
                  </td>
                  <td className="px-3 py-1.5">
                    <Sparkline points={row.spark} />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">{row.epcHex}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    {row.firstReadPowerArg !== null ? (
                      `${(row.firstReadPowerArg / 10).toFixed(1)} dBm`
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    {cat?.sku ?? <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-[11px]">
                    {desc || <span className="text-[var(--wms-muted)]">—</span>}
                  </td>
                  <td className="px-3 py-1.5">
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
            {flags.tagFocus ? " · tagfocus" : ""} · elapsed{" "}
            {Math.round(elapsedMs / 1000)} s
          </div>
        )}
      </div>
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
