"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Play, Pause, Square } from "lucide-react";

/**
 * Live Scan widget — moved out of dashboard's command-center into Hardware
 * Config (2026-05-12). Three states:
 *   - IDLE: collapsed, no per-antenna detail, shows "(start to run)"
 *   - RUNNING: per-antenna grid revealed, counter ticking, all reads land
 *     in cdm_reads
 *   - PAUSED: grid stays visible (snapshot of last counts), but the
 *     live-scan SESSION is ended server-side so readers go idle. Operator
 *     can resume by clicking Start again.
 *   - STOP: session ended, grid collapsed, final formula-passing count
 *     surfaced (and persisted to live_scan_sessions for the dashboard
 *     Last Scan pill).
 *
 * The headline counter is sourced ONLY from /api/dashboard/live-scan/state,
 * which counts cdm_reads WHERE passes_formula=true since session start.
 * Earlier the counter blended SSE-streamed EPCs (which include garbage
 * non-Carbon tags) with the formula-passing server total, producing a
 * jarring drop on Stop when the SSE count was way higher than reality.
 * Now the live tick and the final number are the same metric — they only
 * differ by polling latency (500 ms).
 */
type PerAntennaRow = {
  reader_id: string;
  reader_name: string;
  antenna_id: string;
  antenna_name: string;
  antenna_number: number;
  network_address: string | null;
  unique_epcs: number;
};

type WidgetState = "idle" | "running" | "paused" | "stopped";

export function LiveScanWidget() {
  const [state, setState] = useState<WidgetState>("idle");
  const [count, setCount] = useState(0);
  // Frozen count on Pause/Stop — what the operator sees after the session ends.
  const [frozenCount, setFrozenCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [perAntenna, setPerAntenna] = useState<PerAntennaRow[]>([]);
  // Frozen per-antenna grid on Pause — preserves the breakdown the operator
  // was looking at when they hit Pause.
  const [frozenPerAntenna, setFrozenPerAntenna] = useState<PerAntennaRow[] | null>(null);

  // Resume detection on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as { active?: boolean; count?: number };
        if (cancelled) return;
        if (j.active) {
          setState("running");
          setCount(j.count ?? 0);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Headline counter poll — uses ONLY the server-side count (which filters
  // passes_formula=true). No SSE-based tick anymore: it was the cause of
  // the post-Stop "live shows 12k, final says 4k" gap operators reported.
  // 500ms is plenty fast for an inventory feel.
  useEffect(() => {
    if (state !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as { active?: boolean; count?: number };
        if (cancelled) return;
        if (!j.active) {
          // Server auto-expired or stopped externally.
          setState("idle");
          setCount(0);
          return;
        }
        setCount((prev) => Math.max(prev, j.count ?? 0));
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state]);

  // Per-antenna breakdown poll — same filter as headline. 1s cadence.
  useEffect(() => {
    if (state !== "running") {
      // Don't blow away the breakdown on Pause — frozenPerAntenna preserves it.
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/per-antenna");
        if (!res.ok) return;
        const j = (await res.json()) as { active: boolean; antennas?: PerAntennaRow[] };
        if (cancelled) return;
        if (!j.active) {
          setPerAntenna([]);
          return;
        }
        setPerAntenna(j.antennas ?? []);
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state]);

  const onStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/dashboard/live-scan/start", { method: "POST" });
      if (!res.ok) return;
      setCount(0);
      setFrozenCount(null);
      setFrozenPerAntenna(null);
      setState("running");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const onPause = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Snapshot current counts before ending the server session.
      setFrozenCount(count);
      setFrozenPerAntenna(perAntenna);
      await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
      setState("paused");
    } finally {
      setBusy(false);
    }
  }, [busy, count, perAntenna]);

  const onStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // If we're paused (already stopped server-side) just collapse.
      if (state === "running") {
        await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
      }
      setFrozenCount(count > 0 ? count : frozenCount);
      setFrozenPerAntenna(null); // collapse the grid
      setPerAntenna([]);
      setState("stopped");
    } finally {
      setBusy(false);
    }
  }, [busy, state, count, frozenCount]);

  const live = state === "running";
  const displayCount = live ? count : (frozenCount ?? count);
  // RUNNING shows the live grid; PAUSED shows the frozen grid; STOPPED/IDLE
  // show nothing.
  const gridRows: PerAntennaRow[] =
    state === "running"
      ? perAntenna
      : state === "paused"
        ? (frozenPerAntenna ?? [])
        : [];

  return (
    <div className="mb-4 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`relative flex h-2.5 w-2.5 rounded-full ${
              live ? "bg-emerald-500" : state === "paused" ? "bg-amber-500" : "bg-[var(--wms-muted)]"
            }`}
            aria-hidden
          >
            {live ? (
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />
            ) : null}
          </span>
          <Radio className="h-4 w-4 text-[var(--wms-accent)]" />
          <span className="font-mono text-sm font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
            Live Scan
          </span>
          {state === "paused" ? (
            <span className="rounded border border-amber-400/60 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-amber-300">
              paused
            </span>
          ) : state === "stopped" ? (
            <span className="rounded border border-[var(--wms-border)] px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
              stopped
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold tabular-nums text-[var(--wms-fg)]">
            {displayCount.toLocaleString()}
          </span>
          <span className="font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">
            {state === "stopped" ? "EPCs (final)" : "unique EPCs"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state !== "running" ? (
            <button
              type="button"
              onClick={onStart}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/50 bg-emerald-500/15 px-3 py-1.5 font-mono text-sm font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-60"
            >
              <Play className="h-3.5 w-3.5" />
              Start
            </button>
          ) : null}
          {state === "running" ? (
            <button
              type="button"
              onClick={onPause}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/50 bg-amber-500/15 px-3 py-1.5 font-mono text-sm font-semibold text-amber-300 hover:bg-amber-500/25 disabled:opacity-60"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          ) : null}
          {state === "running" || state === "paused" ? (
            <button
              type="button"
              onClick={onStop}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-400/50 bg-red-500/15 px-3 py-1.5 font-mono text-sm font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-60"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          ) : null}
        </div>
      </div>
      {gridRows.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
          {gridRows.map((a) => (
            <div
              key={a.antenna_id}
              className="flex items-center justify-between rounded border border-[var(--wms-border)]/60 bg-[var(--wms-surface-elevated)]/60 px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-[0.7rem] text-[var(--wms-fg)]">
                  {a.reader_name}
                </div>
                <div className="truncate font-mono text-[0.55rem] text-[var(--wms-muted)]">
                  ant #{a.antenna_number}
                  {a.network_address ? ` · ${a.network_address}` : ""}
                </div>
              </div>
              <div className="ml-2 font-mono text-base font-semibold text-[var(--wms-accent)]">
                {a.unique_epcs}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
