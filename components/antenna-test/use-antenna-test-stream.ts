"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AntennaTestRow = {
  epcHex: string;
  /** Most recent RSSI sample. */
  rssiDbm: number;
  /** Strongest (least-negative) RSSI seen for this EPC during the session. */
  bestRssiDbm: number;
  /** Antenna stamp (always the test's antenna). */
  antennaNumber: number;
  /** Total times this EPC was reported. */
  reads: number;
  /** ms-since-epoch first time this EPC was seen this session. */
  firstSeenMs: number;
  /** ms-since-epoch most recent sample. */
  lastSeenMs: number;
  /** Sliding window of {ms, rssi} for the sparkline (last 5 s). */
  spark: { ms: number; rssi: number }[];
  /** Lowest power dBm × 10 at which we first saw this EPC — populated only
   *  during sweep mode. */
  firstReadPowerArg: number | null;
};

export type AntennaTestStats = {
  uniqueEpcs: number;
  totalReads: number;
  droppedBadCrc: number;
};

export type AntennaTestSweepProgress = {
  currentPowerArg: number;
  stepIndex: number;
  totalSteps: number;
  stepEndsAtMs: number;
};

export type AntennaTestStatus = "idle" | "armed" | "live" | "ended" | "sweep_done";

const SPARK_WINDOW_MS = 5_000;

type StreamMessage =
  | {
      kind: "read";
      read: {
        epcHex: string;
        rssiDbm: number;
        antennaNumber: number;
        observedAt: string;
        powerArg?: number;
      };
    }
  | {
      kind: "lifecycle";
      status: "armed" | "live" | "ended" | "sweep_done";
      reason?: string;
    }
  | { kind: "stats"; uniqueEpcs: number; totalReads: number; droppedBadCrc: number }
  | {
      kind: "sweep_progress";
      currentPowerArg: number;
      stepIndex: number;
      totalSteps: number;
      stepEndsAtMs: number;
    };

export function useAntennaTestStream(
  sessionId: string | null,
  paused: boolean = false,
  streamUrl: string = "/api/antenna-test/stream",
) {
  const [rows, setRows] = useState<Map<string, AntennaTestRow>>(new Map());
  const [stats, setStats] = useState<AntennaTestStats>({
    uniqueEpcs: 0,
    totalReads: 0,
    droppedBadCrc: 0,
  });
  const [status, setStatus] = useState<AntennaTestStatus>("idle");
  /** Last lifecycle event's `reason` field. Surfaced to the UI so it can
   *  explain WHY a session armed/ended (e.g. "bridge held by production",
   *  binary stderr message, spawn error). */
  const [lifecycleReason, setLifecycleReason] = useState<string | null>(null);
  const [sweepProgress, setSweepProgress] =
    useState<AntennaTestSweepProgress | null>(null);
  /** Ref so the SSE handler doesn't re-run on every state change. */
  const rowsRef = useRef<Map<string, AntennaTestRow>>(new Map());
  /** Pause is consulted on every incoming read — hold in a ref so the live
   *  SSE handler picks up the latest value without re-subscribing. While
   *  paused, reads are simply dropped: radio keeps cycling server-side, the
   *  table is frozen client-side, and resume picks up from the next read. */
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Only clear when starting a NEW session — when sessionId goes null
  // (Stop), the table stays visible until the operator explicitly clears.
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionRef.current;
    prevSessionRef.current = sessionId;
    if (sessionId && sessionId !== prev) {
      // New session starting — wipe stale rows from a prior run.
      rowsRef.current = new Map();
      setRows(new Map());
      setStats({ uniqueEpcs: 0, totalReads: 0, droppedBadCrc: 0 });
      setSweepProgress(null);
      setStatus("armed");
      setLifecycleReason(null);
    }
  }, [sessionId]);

  /** Wipe all locally-held results — table goes empty and status flips to
   *  idle. Wired to the workspace's "Clear session" button. */
  const clear = useCallback(() => {
    rowsRef.current = new Map();
    setRows(new Map());
    setStats({ uniqueEpcs: 0, totalReads: 0, droppedBadCrc: 0 });
    setSweepProgress(null);
    setStatus("idle");
    setLifecycleReason(null);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      // No active SSE; rows/state persist (frozen final view from last run).
      return;
    }

    const es = new EventSource(`${streamUrl}?sessionId=${encodeURIComponent(sessionId)}`);
    let pendingFlush: number | null = null;
    let dirty = false;

    const flush = () => {
      pendingFlush = null;
      if (!dirty) return;
      dirty = false;
      // Take a fresh shallow copy so React's setState detects change cheaply.
      // Each row is a stable reference unless mutated in this batch.
      setRows(new Map(rowsRef.current));
    };

    const scheduleFlush = () => {
      if (pendingFlush !== null) return;
      // 80ms render coalesce — fine-grained enough to feel live, coarse enough
      // to avoid 1500-rerenders/sec when reads are flowing fast.
      pendingFlush = window.setTimeout(flush, 80);
    };

    es.onmessage = (ev) => {
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return;
      }
      // Lifecycle, stats, sweep_progress always pass through so the
      // status pill stays accurate. Read-events are the only thing pause
      // gates — that's the operator's freeze semantic.
      if (msg.kind === "lifecycle") {
        setStatus(msg.status);
        if (msg.reason !== undefined) setLifecycleReason(msg.reason);
        return;
      }
      if (msg.kind === "stats") {
        setStats({
          uniqueEpcs: msg.uniqueEpcs,
          totalReads: msg.totalReads,
          droppedBadCrc: msg.droppedBadCrc,
        });
        return;
      }
      if (msg.kind === "sweep_progress") {
        setSweepProgress({
          currentPowerArg: msg.currentPowerArg,
          stepIndex: msg.stepIndex,
          totalSteps: msg.totalSteps,
          stepEndsAtMs: msg.stepEndsAtMs,
        });
        return;
      }
      // kind === "read"
      if (pausedRef.current) return;
      const r = msg.read;
      const now = Date.now();
      const epc = r.epcHex.toUpperCase();
      let row = rowsRef.current.get(epc);
      if (!row) {
        row = {
          epcHex: epc,
          rssiDbm: r.rssiDbm,
          bestRssiDbm: r.rssiDbm,
          antennaNumber: r.antennaNumber,
          reads: 1,
          firstSeenMs: now,
          lastSeenMs: now,
          spark: [{ ms: now, rssi: r.rssiDbm }],
          firstReadPowerArg: r.powerArg ?? null,
        };
        rowsRef.current.set(epc, row);
      } else {
        row.rssiDbm = r.rssiDbm;
        if (r.rssiDbm > row.bestRssiDbm) row.bestRssiDbm = r.rssiDbm;
        row.reads += 1;
        row.lastSeenMs = now;
        row.spark.push({ ms: now, rssi: r.rssiDbm });
        const cutoff = now - SPARK_WINDOW_MS;
        while (row.spark.length > 0 && row.spark[0]!.ms < cutoff) row.spark.shift();
        if (r.powerArg !== undefined) {
          if (row.firstReadPowerArg === null || r.powerArg < row.firstReadPowerArg) {
            row.firstReadPowerArg = r.powerArg;
          }
        }
      }
      if (status === "armed") setStatus("live");
      dirty = true;
      scheduleFlush();
    };

    es.onerror = () => {
      // EventSource auto-reconnects; we just note status.
      // (Status will go back to "live" on the next read or "armed" if no
      // reads are flowing yet.)
    };

    return () => {
      if (pendingFlush !== null) window.clearTimeout(pendingFlush);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { rows, stats, status, lifecycleReason, sweepProgress, clear };
}
