"use client";

/**
 * Locate Tag — the fixed-reader Geiger.
 *
 *   1. Pick ONE target EPC (search by EPC / SKU / description / bin / …, or
 *      paste a raw 24-hex EPC that has no items row yet).
 *   2. Pick the readers to hunt with (default: none — nothing is woken until
 *      the operator chooses).
 *   3. Hit SCAN. Each selected reader is woken via a `geiger` scan-session and
 *      every read it produces streams back over the existing edge SSE channel,
 *      which already carries per-EPC RSSI (`epcRssiMap`). Each reader gets a
 *      live signal bar + coarse foot band.
 *   4. Optional REFINE on any reader with contact: preempts that one reader
 *      into a power-ramp (the antenna-test sweep, 10 → 33 dBm) and reports the
 *      lowest power at which the tag answered, converted to feet through that
 *      antenna's calibration points. That is the only trustworthy number on
 *      the page; the RSSI bands are a proximity hint, not a measurement.
 *
 * Nothing here writes to inventory — locating a tag is read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Radio, Loader2, Search, X, Crosshair, Ruler } from "lucide-react";

import { ReaderPicker } from "@/components/shared/reader-picker";
import { useReaderWake } from "@/components/shared/use-reader-wake";
import {
  rssiBucket,
  rssiToFeet,
  rssiToBarFraction,
  refineFeet,
  type CalibrationPoint,
  type DistanceEstimate,
} from "@/lib/rfid-geiger-distance";
import type { TrackerSearchPickRow } from "@/lib/rfid-tracker-types";
import type { HardwareConfigTree } from "@/lib/server/hardware-config";

/** A reader is "in contact" while it has seen the target this recently. */
const CONTACT_TTL_MS = 4_000;
/** UI repaint cadence while hunting — drives the bar drain + "x ago" labels. */
const TICK_MS = 250;
/** Power ramp: 10.0 → 33.0 dBm in 1.0 dBm steps, 1.5 s dwell ⇒ ~35 s worst case. */
const REFINE_SWEEP = {
  startPowerArg: 100,
  endPowerArg: 330,
  stepPowerArg: 10,
  dwellMs: 1500,
} as const;

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return r.json();
};

type Target = {
  epc: string;
  /** Catalog fields — all null for a raw EPC with no items row. */
  sku: string | null;
  description: string | null;
  color: string | null;
  size: string | null;
  status: string | null;
  locationCode: string | null;
  binCode: string | null;
  archived: boolean;
};

type ReaderStat = {
  reads: number;
  lastRssi: number | null;
  bestRssi: number | null;
  firstSeenMs: number;
  lastSeenMs: number;
};

type RefineState = {
  readerId: string;
  antennaId: string;
  sessionId: string | null;
  phase: "starting" | "ramping" | "done" | "error";
  currentPowerArg: number | null;
  stepIndex: number;
  totalSteps: number;
  foundPowerArg: number | null;
  estimate: DistanceEstimate | null;
  message: string | null;
};

/** Narrow local mirror of the antenna-test SSE payload (server type is not client-safe). */
type SweepMessage =
  | { kind: "read"; read: { epcHex: string; rssiDbm: number; powerArg?: number } }
  | { kind: "lifecycle"; status: "armed" | "live" | "ended" | "sweep_done"; reason?: string }
  | { kind: "stats"; uniqueEpcs: number; totalReads: number; droppedBadCrc: number }
  | {
      kind: "sweep_progress";
      currentPowerArg: number;
      stepIndex: number;
      totalSteps: number;
      stepEndsAtMs: number;
    };

type FlatReader = {
  id: string;
  name: string;
  zoneName: string;
  locationCode: string;
  online: boolean;
  antennaId: string | null;
};

function flattenReaders(tree: HardwareConfigTree | undefined): FlatReader[] {
  if (!tree?.locations) return [];
  const out: FlatReader[] = [];
  for (const loc of tree.locations) {
    const push = (r: HardwareConfigTree["locations"][number]["zones"][number]["readers"][number], zoneName: string) => {
      out.push({
        id: r.id,
        name: r.name,
        zoneName,
        locationCode: loc.code,
        online: r.status_online,
        antennaId: r.antennas?.[0]?.id ?? null,
      });
    };
    for (const z of loc.zones ?? []) for (const r of z.readers ?? []) push(r, z.name);
    for (const r of loc.unzonedReaders ?? []) push(r, "—");
  }
  return out;
}

function agoLabel(ms: number): string {
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

export function LocateTagWorkspace() {
  // ── Target selection ─────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TrackerSearchPickRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const targetRef = useRef<Target | null>(null);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const [err, setErr] = useState<string | null>(null);

  // Debounced search. Skipped entirely once a target is locked in.
  useEffect(() => {
    const q = query.trim();
    if (target || q.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/rfid/tracker/search?q=${encodeURIComponent(q)}`, {
            cache: "no-store",
          });
          if (!res.ok) throw new Error("search failed");
          const j = (await res.json()) as {
            result?: { mode: string; matches?: TrackerSearchPickRow[] };
          };
          if (!cancelled) setMatches(j.result?.matches ?? []);
        } catch {
          if (!cancelled) setMatches([]);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, target]);

  const rawEpcCandidate = useMemo(() => {
    const t = query.replace(/\s/g, "").toUpperCase();
    return /^[0-9A-F]{24}$/.test(t) ? t : null;
  }, [query]);

  // ── Reader selection + hunt lifecycle ────────────────────────────────────
  const { data: hwTree } = useSWR<HardwareConfigTree>("/api/hardware-config", fetcher, {
    revalidateOnFocus: false,
  });
  const readers = useMemo(() => flattenReaders(hwTree), [hwTree]);
  const readerById = useMemo(() => new Map(readers.map((r) => [r.id, r])), [readers]);

  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(() => new Set());
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  const [hunting, setHunting] = useState(false);
  const huntingRef = useRef(hunting);
  useEffect(() => {
    huntingRef.current = hunting;
  }, [hunting]);

  const scanSessionIdsRef = useRef<string[]>([]);
  const [stats, setStats] = useState<Record<string, ReaderStat>>({});

  // Keep the chosen readers warm while the page is open so SCAN is instant.
  const selectedIdList = useMemo(() => Array.from(selectedReaders), [selectedReaders]);
  useReaderWake({
    active: selectedIdList.length > 0,
    kind: "geiger",
    readerIds: selectedIdList,
  });

  // Repaint clock — only runs while hunting so an idle page is free.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hunting) return;
    const t = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [hunting]);

  const endScanSessions = useCallback(() => {
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
  }, []);

  const stopHunt = useCallback(() => {
    setHunting(false);
    endScanSessions();
  }, [endScanSessions]);

  const startHunt = useCallback(async () => {
    if (!targetRef.current) {
      setErr("Pick a target EPC first.");
      return;
    }
    const ids = Array.from(selectedReadersRef.current);
    if (ids.length === 0) {
      setErr("Pick at least one reader.");
      return;
    }
    setErr(null);
    setStats({});
    const started: string[] = [];
    const failures: string[] = [];
    for (const readerId of ids) {
      try {
        const res = await fetch("/api/scan-sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            readerId,
            kind: "geiger",
            context: { page: "locate", epc: targetRef.current.epc },
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sessionId?: string;
          reason?: string;
          error?: string;
        };
        if (res.ok && j.ok && j.sessionId) started.push(j.sessionId);
        else failures.push(`${readerById.get(readerId)?.name ?? readerId}: ${j.reason ?? j.error ?? "unknown"}`);
      } catch {
        failures.push(`${readerById.get(readerId)?.name ?? readerId}: network error`);
      }
    }
    if (failures.length > 0) {
      setErr(`Could not start ${failures.length} reader(s) — ${failures.join("; ")}`);
    }
    if (started.length > 0) {
      scanSessionIdsRef.current = [...scanSessionIdsRef.current, ...started];
      setHunting(true);
    }
  }, [readerById]);

  // Release every woken reader when the operator leaves the page.
  useEffect(() => endScanSessions, [endScanSessions]);

  // ── Live edge stream: the actual Geiger signal ───────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!huntingRef.current) return;
      const t = targetRef.current;
      if (!t) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: {
        deviceId?: string;
        epcs?: string[];
        epcRssiMap?: Record<string, number>;
      };
      try {
        p = JSON.parse(ev.data) as typeof p;
      } catch {
        return;
      }
      const deviceId = p.deviceId;
      if (!deviceId || !selectedReadersRef.current.has(deviceId)) return;
      const seen = (p.epcs ?? []).some((e) => e.replace(/\s/g, "").toUpperCase() === t.epc);
      if (!seen) return;
      const rssi = p.epcRssiMap?.[t.epc] ?? null;
      const at = Date.now();
      setStats((prev) => {
        const cur = prev[deviceId];
        return {
          ...prev,
          [deviceId]: {
            reads: (cur?.reads ?? 0) + 1,
            lastRssi: rssi,
            bestRssi:
              rssi === null
                ? cur?.bestRssi ?? null
                : cur?.bestRssi === null || cur?.bestRssi === undefined
                  ? rssi
                  : Math.max(cur.bestRssi, rssi),
            firstSeenMs: cur?.firstSeenMs ?? at,
            lastSeenMs: at,
          },
        };
      });
    };
    return () => es.close();
  }, []);

  // ── Refine: power-ramp one reader for a real foot number ─────────────────
  const [refine, setRefine] = useState<RefineState | null>(null);
  const refineRef = useRef<RefineState | null>(null);
  useEffect(() => {
    refineRef.current = refine;
  }, [refine]);
  const calibPointsRef = useRef<CalibrationPoint[]>([]);

  const stopRefineSession = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    void fetch("/api/antenna-test/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const startRefine = useCallback(
    async (readerId: string) => {
      const t = targetRef.current;
      const reader = readerById.get(readerId);
      if (!t || !reader) return;
      if (!reader.antennaId) {
        setErr(`${reader.name} has no antenna registered — cannot ramp.`);
        return;
      }
      setErr(null);
      setRefine({
        readerId,
        antennaId: reader.antennaId,
        sessionId: null,
        phase: "starting",
        currentPowerArg: null,
        stepIndex: 0,
        totalSteps:
          Math.floor((REFINE_SWEEP.endPowerArg - REFINE_SWEEP.startPowerArg) / REFINE_SWEEP.stepPowerArg) + 1,
        foundPowerArg: null,
        estimate: null,
        message: null,
      });

      // Calibration points for this antenna decide whether the answer is a
      // measurement or the generic curve. Fetched before the ramp so the
      // result renders the instant the tag answers.
      try {
        const cres = await fetch(
          `/api/antenna-test/calibrate?readerId=${readerId}&antennaId=${reader.antennaId}`,
          { cache: "no-store" },
        );
        const cj = (await cres.json().catch(() => ({}))) as { points?: CalibrationPoint[] };
        calibPointsRef.current = cj.points ?? [];
      } catch {
        calibPointsRef.current = [];
      }

      try {
        const res = await fetch("/api/antenna-test/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            antennaId: reader.antennaId,
            flags: {
              powerArg: REFINE_SWEEP.startPowerArg,
              readTimeMs: 1000,
              cycleMode: "infinite",
              tagFocus: false,
            },
            sweep: REFINE_SWEEP,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { sessionId?: string; error?: string };
        if (!res.ok || !j.sessionId) {
          setRefine((r) =>
            r ? { ...r, phase: "error", message: j.error ?? "Could not start the ramp." } : r,
          );
          return;
        }
        setRefine((r) => (r ? { ...r, sessionId: j.sessionId!, phase: "ramping" } : r));
      } catch {
        setRefine((r) => (r ? { ...r, phase: "error", message: "Network error starting the ramp." } : r));
      }
    },
    [readerById],
  );

  const cancelRefine = useCallback(() => {
    stopRefineSession(refineRef.current?.sessionId ?? null);
    setRefine(null);
  }, [stopRefineSession]);

  // Subscribe to the ramp's own SSE channel for as long as one is running.
  const refineSessionId = refine?.sessionId ?? null;
  useEffect(() => {
    if (!refineSessionId) return;
    const es = new EventSource(`/api/antenna-test/stream?sessionId=${refineSessionId}`);
    es.onmessage = (ev) => {
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let m: SweepMessage;
      try {
        m = JSON.parse(ev.data) as SweepMessage;
      } catch {
        return;
      }
      const t = targetRef.current;
      if (!t) return;

      if (m.kind === "sweep_progress") {
        setRefine((r) =>
          r && r.foundPowerArg === null
            ? {
                ...r,
                currentPowerArg: m.currentPowerArg,
                stepIndex: m.stepIndex,
                totalSteps: m.totalSteps,
              }
            : r,
        );
        return;
      }

      if (m.kind === "read") {
        if (m.read.epcHex.replace(/\s/g, "").toUpperCase() !== t.epc) return;
        // First power at which the target answered IS the measurement — the
        // ramp only climbs, so the first hit is the lowest power that works.
        const power = m.read.powerArg ?? refineRef.current?.currentPowerArg ?? null;
        if (power === null) return;
        setRefine((r) => {
          if (!r || r.foundPowerArg !== null) return r;
          stopRefineSession(r.sessionId);
          return {
            ...r,
            phase: "done",
            foundPowerArg: power,
            estimate: refineFeet(calibPointsRef.current, power),
          };
        });
        return;
      }

      if (m.kind === "lifecycle" && (m.status === "sweep_done" || m.status === "ended")) {
        setRefine((r) => {
          if (!r || r.foundPowerArg !== null) return r;
          stopRefineSession(r.sessionId);
          return {
            ...r,
            phase: "done",
            message: "No answer at any power up to 33 dBm — the tag is out of this reader's range.",
          };
        });
      }
    };
    return () => es.close();
  }, [refineSessionId, stopRefineSession]);

  // Never leave a reader pinned in TEST_MODE if the operator navigates away.
  useEffect(() => {
    return () => stopRefineSession(refineRef.current?.sessionId ?? null);
  }, [stopRefineSession]);

  // ── Derived rows ─────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    return Array.from(selectedReaders)
      .map((id) => {
        const reader = readerById.get(id);
        const s = stats[id];
        const age = s ? nowMs - s.lastSeenMs : null;
        const fresh = age !== null && age <= CONTACT_TTL_MS;
        return {
          id,
          name: reader?.name ?? id.slice(0, 8),
          zoneName: reader?.zoneName ?? "—",
          online: reader?.online ?? false,
          hasAntenna: Boolean(reader?.antennaId),
          stat: s ?? null,
          age,
          fresh,
          liveRssi: fresh ? s?.lastRssi ?? null : null,
        };
      })
      .sort((a, b) => {
        // Strongest live contact first, then anything ever seen, then silence.
        const av = a.liveRssi ?? (a.stat ? -998 : -999);
        const bv = b.liveRssi ?? (b.stat ? -998 : -999);
        return bv - av || a.name.localeCompare(b.name);
      });
  }, [selectedReaders, readerById, stats, nowMs]);

  const contactCount = rows.filter((r) => r.fresh).length;
  const bestRow = rows.find((r) => r.liveRssi !== null) ?? null;

  return (
    <div className="space-y-4">
      {/* ── Target ──────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        {target ? (
          <div className="flex flex-wrap items-start gap-3">
            <Crosshair className="mt-0.5 h-4 w-4 shrink-0 text-[var(--wms-accent)]" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm font-semibold text-teal-400/90 max-md:break-all">
                {target.epc}
              </div>
              <div className="mt-0.5 font-mono text-xs text-[var(--wms-fg)]">
                {target.sku ? (
                  <>
                    {target.sku}
                    {target.description ? ` · ${target.description}` : ""}
                    {[target.color, target.size].filter(Boolean).length > 0
                      ? ` · ${[target.color, target.size].filter(Boolean).join(" / ")}`
                      : ""}
                  </>
                ) : (
                  <span className="text-amber-300/80">
                    Raw EPC — no catalog item at this location
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                {target.status ? <span>status {target.status}</span> : null}
                {target.binCode ? <span>· last bin {target.binCode}</span> : null}
                {target.locationCode ? <span>· {target.locationCode}</span> : null}
                {target.archived ? (
                  <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
                    SKU archived
                  </span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                stopHunt();
                cancelRefine();
                setTarget(null);
                setStats({});
                setQuery("");
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] max-md:min-h-11"
            >
              <X className="h-3.5 w-3.5" />
              Change
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <label
              htmlFor="locate-search"
              className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]"
            >
              <Search className="h-3.5 w-3.5" />
              Target tag
            </label>
            <input
              id="locate-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="EPC, SKU, description, colour, size, bin…"
              spellCheck={false}
              autoComplete="off"
              enterKeyHint="search"
              className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-[var(--wms-accent)] focus:outline-none max-md:text-base"
            />
            {searching ? (
              <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">Searching…</p>
            ) : null}
            {rawEpcCandidate && !matches.some((m) => m.epc.toUpperCase() === rawEpcCandidate) ? (
              <button
                type="button"
                onClick={() =>
                  setTarget({
                    epc: rawEpcCandidate,
                    sku: null,
                    description: null,
                    color: null,
                    size: null,
                    status: null,
                    locationCode: null,
                    binCode: null,
                    archived: false,
                  })
                }
                className="w-full rounded-md border border-dashed border-[var(--wms-accent)]/50 px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/10 max-md:min-h-11"
              >
                Hunt raw EPC <span className="text-teal-400/90">{rawEpcCandidate}</span> (no catalog
                match)
              </button>
            ) : null}
            {matches.length > 0 ? (
              <ul className="max-h-[40dvh] divide-y divide-[var(--wms-border)]/50 overflow-y-auto rounded-md border border-[var(--wms-border)] max-md:overscroll-contain">
                {matches.map((m) => (
                  <li key={m.epc}>
                    <button
                      type="button"
                      onClick={() =>
                        setTarget({
                          epc: m.epc.toUpperCase(),
                          sku: m.sku,
                          description: m.description,
                          color: m.color,
                          size: m.size,
                          status: m.status,
                          locationCode: m.location_code,
                          binCode: m.bin_code,
                          archived: m.archived,
                        })
                      }
                      className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11"
                    >
                      <span className="font-mono text-xs font-semibold text-teal-400/90 max-md:break-all">
                        {m.epc}
                      </span>
                      <span className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
                        {[m.sku, m.description, m.color, m.size].filter(Boolean).join(" · ")}
                        {m.bin_code ? ` · bin ${m.bin_code}` : ""}
                        {m.archived ? " · archived" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={() => (hunting ? stopHunt() : void startHunt())}
          disabled={!target || (!hunting && selectedReaders.size === 0)}
          title={
            !target
              ? "Pick a target EPC first."
              : selectedReaders.size === 0 && !hunting
                ? "Pick at least one reader."
                : undefined
          }
          className={`inline-flex min-h-[2.75rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-2.5 font-mono text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            hunting
              ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
          }`}
        >
          <Radio className={`h-5 w-5 ${hunting ? "animate-pulse text-amber-400" : "text-[var(--wms-muted)]"}`} />
          {hunting ? "Scanning… (click to stop)" : "Scan"}
        </button>
        <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} hidePosDedicated />
        <span className="ml-auto font-mono text-[10px] text-[var(--wms-muted)]">
          <strong className="text-[var(--wms-fg)]">{selectedReaders.size}</strong> reader(s) ·{" "}
          <strong className={contactCount > 0 ? "text-emerald-300" : "text-[var(--wms-muted)]"}>
            {contactCount}
          </strong>{" "}
          in contact
        </span>
      </div>

      {err ? (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300">
          {err}
        </div>
      ) : null}

      {/* ── Per-reader Geiger readout ───────────────────────────────────── */}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--wms-border)] px-3 py-10 text-center font-mono text-xs text-[var(--wms-muted)]">
          Pick a target tag and the readers to hunt with, then press Scan.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const bucket = row.liveRssi !== null ? rssiBucket(row.liveRssi) : null;
            const fill = row.liveRssi !== null ? rssiToBarFraction(row.liveRssi) : 0;
            const feet = row.liveRssi !== null ? rssiToFeet(row.liveRssi) : null;
            const isRefining = refine?.readerId === row.id;
            return (
              <li
                key={row.id}
                className={`rounded-lg border px-3 py-3 ${
                  row.fresh
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-[var(--wms-border)] bg-[var(--wms-surface)]/60"
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  {/* Phones give the reader name its own row so the bar keeps
                      a usable width; desktop keeps all three on one line. */}
                  <div className="min-w-0 flex-1 max-md:basis-full">
                    <div className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
                      {row.name}
                      {!row.online ? (
                        <span className="ml-2 font-normal text-[0.65rem] text-amber-300/80">offline</span>
                      ) : null}
                    </div>
                    <div className="font-mono text-[0.65rem] text-[var(--wms-muted)]">{row.zoneName}</div>
                  </div>

                  {/* Signal bar — the live Geiger needle. */}
                  <div className="flex min-w-[9rem] flex-1 items-center gap-2">
                    <div
                      className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]"
                      role="meter"
                      aria-label={`${row.name} signal`}
                      aria-valuenow={Math.round(fill * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-200"
                        style={{
                          width: `${Math.round(fill * 100)}%`,
                          background: bucket?.color ?? "transparent",
                        }}
                      />
                    </div>
                    <span className="w-[4.5rem] shrink-0 text-right font-mono text-xs tabular-nums text-[var(--wms-fg)]">
                      {row.liveRssi !== null ? `${row.liveRssi.toFixed(0)} dBm` : "—"}
                    </span>
                  </div>

                  <div className="w-[8.5rem] shrink-0 text-right">
                    {bucket && feet !== null ? (
                      <>
                        <div className="font-mono text-sm font-semibold" style={{ color: bucket.color }}>
                          ≈ {feet < 10 ? feet.toFixed(1) : Math.round(feet)} ft
                        </div>
                        <div className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
                          {bucket.label}
                        </div>
                      </>
                    ) : (
                      <div className="font-mono text-xs text-[var(--wms-muted)]">
                        {row.stat ? `lost · ${agoLabel(row.age ?? 0)}` : hunting ? "listening…" : "no contact"}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                  <span>{row.stat?.reads ?? 0} reads</span>
                  {row.stat?.bestRssi !== null && row.stat?.bestRssi !== undefined ? (
                    <span>· best {row.stat.bestRssi.toFixed(0)} dBm</span>
                  ) : null}
                  {row.age !== null ? <span>· seen {agoLabel(row.age)}</span> : null}

                  <button
                    type="button"
                    onClick={() => (isRefining ? cancelRefine() : void startRefine(row.id))}
                    disabled={!target || !row.hasAntenna || (refine !== null && !isRefining)}
                    title={
                      !row.hasAntenna
                        ? "No antenna registered on this reader."
                        : "Ramp this reader 10 → 33 dBm and report the lowest power the tag answers at."
                    }
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:border-teal-500/40 disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11"
                  >
                    {isRefining && (refine?.phase === "starting" || refine?.phase === "ramping") ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Ruler className="h-3.5 w-3.5" />
                    )}
                    {!isRefining
                      ? "Refine"
                      : refine?.phase === "done" || refine?.phase === "error"
                        ? "Clear"
                        : "Cancel ramp"}
                  </button>
                </div>

                {/* Ramp panel — only under the reader being measured. */}
                {isRefining && refine ? (
                  <div className="mt-2 rounded-md border border-teal-500/40 bg-teal-500/5 px-3 py-2 font-mono text-xs text-[var(--wms-fg)]">
                    {refine.phase === "starting" ? (
                      <span className="text-[var(--wms-muted)]">Preempting reader into ramp mode…</span>
                    ) : null}
                    {refine.phase === "ramping" ? (
                      <div className="space-y-1">
                        <div>
                          Ramping{" "}
                          <strong className="tabular-nums">
                            {refine.currentPowerArg !== null
                              ? (refine.currentPowerArg / 10).toFixed(1)
                              : (REFINE_SWEEP.startPowerArg / 10).toFixed(1)}{" "}
                            dBm
                          </strong>{" "}
                          <span className="text-[var(--wms-muted)]">
                            (step {refine.stepIndex + 1} / {refine.totalSteps}) — this reader is paused
                            from normal scanning while it ramps.
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
                          <div
                            className="h-full rounded-full bg-teal-500/70 transition-[width] duration-300"
                            style={{
                              width: `${Math.round(((refine.stepIndex + 1) / Math.max(1, refine.totalSteps)) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {refine.phase === "done" && refine.foundPowerArg !== null && refine.estimate ? (
                      <div className="space-y-0.5">
                        <div className="text-sm font-semibold text-teal-300">
                          {refine.estimate.band}
                        </div>
                        <div className="text-[0.65rem] text-[var(--wms-muted)]">
                          first answered at {(refine.foundPowerArg / 10).toFixed(1)} dBm ·{" "}
                          {refine.estimate.precision === "uncalibrated"
                            ? "generic curve — calibrate this antenna on the Antenna Test page for a measured figure"
                            : `from ${calibPointsRef.current.length} calibration point(s)`}
                        </div>
                      </div>
                    ) : null}
                    {refine.phase === "done" && refine.foundPowerArg === null ? (
                      <span className="text-amber-300/90">{refine.message}</span>
                    ) : null}
                    {refine.phase === "error" ? (
                      <span className="text-red-300">{refine.message}</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {bestRow && bestRow.liveRssi !== null ? (
        <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Strongest right now: <strong className="text-[var(--wms-fg)]">{bestRow.name}</strong> at{" "}
          {bestRow.liveRssi.toFixed(0)} dBm. RSSI bands are a proximity hint — tag orientation, denim
          and metal move them several feet. Use Refine on the strongest reader for a measured number.
        </p>
      ) : null}
    </div>
  );
}
