"use client";

import { useEffect, useRef, useState } from "react";

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

export function useAntennaTestStream(sessionId: string | null) {
  const [rows, setRows] = useState<Map<string, AntennaTestRow>>(new Map());
  const [stats, setStats] = useState<AntennaTestStats>({
    uniqueEpcs: 0,
    totalReads: 0,
    droppedBadCrc: 0,
  });
  const [status, setStatus] = useState<AntennaTestStatus>("idle");
  const [sweepProgress, setSweepProgress] =
    useState<AntennaTestSweepProgress | null>(null);
  /** Ref so the SSE handler doesn't re-run on every state change. */
  const rowsRef = useRef<Map<string, AntennaTestRow>>(new Map());

  useEffect(() => {
    if (!sessionId) {
      // Reset on Stop / no session.
      rowsRef.current = new Map();
      setRows(new Map());
      setStats({ uniqueEpcs: 0, totalReads: 0, droppedBadCrc: 0 });
      setStatus("idle");
      setSweepProgress(null);
      return;
    }
    setStatus("armed");

    const es = new EventSource(`/api/antenna-test/stream?sessionId=${encodeURIComponent(sessionId)}`);
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
      if (msg.kind === "lifecycle") {
        setStatus(msg.status);
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

  return { rows, stats, status, sweepProgress };
}
