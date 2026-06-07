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

  // Per-reader toggle: set of reader_ids the operator has turned OFF in
  // this session. A disabled reader's tiles still poll/SSE-receive
  // updates in the background (so re-enabling pops the current count
  // back instantly), but its contribution is subtracted from the
  // displayed headline and its tile is visually muted. Cleared on
  // Start. Survives Pause (so a paused freeze respects the operator's
  // filter choices).
  const [disabledReaders, setDisabledReaders] = useState<Set<string>>(() => new Set());

  // SSE-driven incremental tick state. Mirrors dashboard CommandCenter so
  // the headline + per-antenna tiles climb 1-by-1 (~250 ms end-to-end from
  // reader stdout) instead of waiting for the 500 ms / 1 s poll cycle to
  // batch-update them. The 500 ms /state poll AND the 1 s /per-antenna
  // poll still run — they cap the SSE-driven counts via upward-only
  // reconciliation, so SSE can never inflate beyond what the server's
  // passes_formula=true count actually is. (The earlier "remove SSE
  // because it over-counts" decision documented in the comment above
  // is preserved as a hazard: the cap is what makes it safe now, and
  // Pause/Stop re-fetch the server count to snap the frozen value.)
  const liveScanEpcsRef = useRef<Set<string>>(new Set());
  const perAntennaEpcsRef = useRef<Map<string, Set<string>>>(new Map());
  // EPC → antenna_id of first SSE sighting this session. Each EPC is
  // attributed to AT MOST ONE antenna's tile (the first one we see for
  // it). Mirrors the server CTE in /api/dashboard/live-scan/per-antenna
  // so SSE ticks and the 1-s poll never disagree on attribution.
  const epcFirstAntennaRef = useRef<Map<string, string>>(new Map());

  // Scan-session heartbeat. The CDM agent no longer wakes readers off the
  // old master live-scan toggle; readers are woken via scan-sessions. We
  // re-POST /api/scan-sessions/prewarm every 15 s for the ENABLED reader
  // set so the server janitor keeps them warm (it colds them ~30 s after
  // the heartbeat stops). Holds the setInterval id while running.
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors of the latest perAntenna / disabledReaders so the heartbeat
  // interval (set up once in onStart) reads fresh values without restarting.
  const perAntennaRef = useRef<PerAntennaRow[]>([]);
  const disabledReadersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    perAntennaRef.current = perAntenna;
  }, [perAntenna]);
  useEffect(() => {
    disabledReadersRef.current = disabledReaders;
  }, [disabledReaders]);

  // Unmount cleanup: clear the heartbeat only. Do NOT POST stop — the
  // server janitor colds readers ~30 s after the heartbeat stops, so a
  // navigation away leaves them to expire naturally rather than racing a
  // stop against a possible quick remount.
  useEffect(() => {
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, []);

  // Resume detection on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as {
          active?: boolean;
          reads_since_start?: number;
        };
        if (cancelled) return;
        if (j.active) {
          setState("running");
          setCount(j.reads_since_start ?? 0);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Headline counter poll — server-side count (filters passes_formula=true)
  // is authoritative. SSE (effect below) adds smooth 1-by-1 ticks between
  // poll cycles but is capped UPWARD-ONLY against the server count, so SSE
  // can't inflate the headline beyond what's actually formula-passing.
  // Pause/Stop explicitly re-snap to the server count to defend against
  // the historical "live shows 12k, final says 4k" gap.
  useEffect(() => {
    if (state !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as {
          active?: boolean;
          reads_since_start?: number;
        };
        if (cancelled) return;
        if (!j.active) {
          // Server auto-expired or stopped externally.
          setState("idle");
          setCount(0);
          return;
        }
        setCount((prev) => Math.max(prev, j.reads_since_start ?? 0));
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
  // Upward-only merge: if SSE has already pushed a row past the server
  // value (briefly, during a burst before the SQL query catches up),
  // keep the SSE value. The server's count(DISTINCT) is the true high-
  // water mark and SSE never exceeds it once the poll catches up.
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
        const serverRows = j.antennas ?? [];
        setPerAntenna((prev) => {
          const prevByAnt = new Map(prev.map((r) => [r.antenna_id, r.unique_epcs]));
          return serverRows.map((row) => {
            const prevCount = prevByAnt.get(row.antenna_id) ?? 0;
            // Keep whichever side is higher — SSE may be momentarily ahead
            // mid-burst; server is authoritative high-water at steady state.
            return row.unique_epcs >= prevCount ? row : { ...row, unique_epcs: prevCount };
          });
        });
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

  // SSE-driven incremental ticks for both the headline counter AND each
  // per-antenna tile. Subscribes to /api/edge/stream, the same hub the
  // dashboard CommandCenter uses. Each event carries a deduped batch of
  // EPCs from fixed-reader ingest (scanContext "TRANSFER") plus an
  // epcAntennaMap for per-antenna attribution. End-to-end latency from
  // reader stdout to UI tick is ~250 ms vs ~500-1000 ms via polls.
  //
  // Safety: all SSE updates are upward-only relative to prior state.
  // The /state poll above is the source of truth and caps SSE eventually.
  useEffect(() => {
    if (state !== "running") {
      liveScanEpcsRef.current = new Set();
      perAntennaEpcsRef.current = new Map();
      epcFirstAntennaRef.current = new Map();
      return;
    }
    const es = new EventSource("/api/edge/stream");
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || ev.data.startsWith(":")) return;
      let parsed: {
        scanContext?: string;
        epcs?: string[];
        epcAntennaMap?: Record<string, string>;
      } | null = null;
      try {
        parsed = JSON.parse(ev.data) as {
          scanContext?: string;
          epcs?: string[];
          epcAntennaMap?: Record<string, string>;
        };
      } catch {
        return;
      }
      if (!parsed?.epcs?.length) return;
      // Fixed-reader agent ingest publishes scanContext "TRANSFER".
      // Handheld scans use other contexts; ignore them (this widget is
      // the master toggle for FIXED readers).
      if (parsed.scanContext && parsed.scanContext !== "TRANSFER") return;
      // Accumulate session-unique EPCs into the headline set, push the
      // size as the new candidate count (upward-only at the setter).
      const set = liveScanEpcsRef.current;
      const beforeSize = set.size;
      for (const e of parsed.epcs) {
        if (typeof e === "string" && e.length > 0) set.add(e.toUpperCase());
      }
      if (set.size !== beforeSize) {
        const newSize = set.size;
        setCount((prev) => (newSize > prev ? newSize : prev));
      }
      // Per-antenna SSE: first-antenna attribution per EPC.
      const map = parsed.epcAntennaMap;
      if (!map) return;
      const touched = new Set<string>();
      for (const epcRaw of Object.keys(map)) {
        const antId = map[epcRaw];
        if (!antId) continue;
        const epc = epcRaw.toUpperCase();
        if (epcFirstAntennaRef.current.has(epc)) continue; // already attributed
        epcFirstAntennaRef.current.set(epc, antId);
        let s = perAntennaEpcsRef.current.get(antId);
        if (!s) {
          s = new Set<string>();
          perAntennaEpcsRef.current.set(antId, s);
        }
        const before = s.size;
        s.add(epc);
        if (s.size !== before) touched.add(antId);
      }
      if (touched.size === 0) return;
      setPerAntenna((prev) =>
        prev.map((row) => {
          if (!touched.has(row.antenna_id)) return row;
          const sseCount = perAntennaEpcsRef.current.get(row.antenna_id)?.size ?? 0;
          return sseCount > row.unique_epcs ? { ...row, unique_epcs: sseCount } : row;
        }),
      );
    };
    es.addEventListener("message", onMessage);
    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
    };
  }, [state]);

  const onStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/dashboard/live-scan/start", { method: "POST" });
      if (!res.ok) return;
      // Wake ALL non-POS readers at this location via scan-sessions (the
      // CDM agent no longer honors the old master toggle to wake readers).
      await fetch("/api/scan-sessions/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "scan-epc" }),
      });
      // 15 s heartbeat re-prewarms the ENABLED set so the server janitor
      // keeps them warm. Empty disabledReaders → prewarm all; otherwise
      // prewarm only the perAntenna reader_ids that are NOT disabled.
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        const disabled = disabledReadersRef.current;
        if (disabled.size === 0) {
          void fetch("/api/scan-sessions/prewarm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "scan-epc" }),
          });
        } else {
          const readerIds = Array.from(
            new Set(
              perAntennaRef.current
                .map((r) => r.reader_id)
                .filter((id) => !disabled.has(id)),
            ),
          );
          void fetch("/api/scan-sessions/prewarm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "scan-epc", readerIds }),
          });
        }
      }, 15000);
      setCount(0);
      setFrozenCount(null);
      setFrozenPerAntenna(null);
      setDisabledReaders(new Set()); // fresh session = all readers enabled
      setState("running");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Toggle one reader's contribution in/out of the headline. Mutates
  // disabledReaders only; per-antenna polling/SSE keep filling the
  // background data so flipping back on instantly restores the tile's
  // current count.
  const toggleReader = useCallback(
    (readerId: string) => {
      setDisabledReaders((prev) => {
        const next = new Set(prev);
        const wasDisabled = next.has(readerId);
        if (wasDisabled) {
          next.delete(readerId);
        } else {
          next.add(readerId);
        }
        // Drive the actual reader via scan-sessions, but only while a live
        // session is running. Re-enabling (wasDisabled=true) → prewarm it;
        // disabling (wasDisabled=false) → stop its session so it goes cold.
        if (state === "running") {
          if (wasDisabled) {
            void fetch("/api/scan-sessions/prewarm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: "scan-epc", readerIds: [readerId] }),
            });
          } else {
            void fetch("/api/scan-sessions/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ readerIds: [readerId] }),
            });
          }
        }
        return next;
      });
    },
    [state],
  );

  const onPause = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Snapshot the AUTHORITATIVE server counts before ending the session.
      // We re-fetch here (instead of trusting the in-state values) because
      // SSE may have ticked the headline / per-antenna tiles slightly ahead
      // of the server's passes_formula=true count. Freezing the server
      // value avoids the "live shows X, frozen shows Y, they disagree" gap.
      let serverCount = count;
      let serverPerAnt = perAntenna;
      try {
        const [s, pa] = await Promise.all([
          fetch("/api/dashboard/live-scan/state").then((r) => (r.ok ? r.json() : null)),
          fetch("/api/dashboard/live-scan/per-antenna").then((r) => (r.ok ? r.json() : null)),
        ]);
        if (s && typeof s.reads_since_start === "number") serverCount = s.reads_since_start;
        if (pa && Array.isArray(pa.antennas)) serverPerAnt = pa.antennas;
      } catch {
        /* fall back to in-state values if poll fails */
      }
      setFrozenCount(serverCount);
      setFrozenPerAntenna(serverPerAnt);
      await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
      // End scan-sessions → readers go cold. Stop the heartbeat.
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      await fetch("/api/scan-sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      setState("paused");
    } finally {
      setBusy(false);
    }
  }, [busy, count, perAntenna]);

  const onStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Re-fetch the authoritative server count before stopping (only when
      // still running — paused state already snapped on Pause). Same
      // reasoning as onPause: SSE may be ahead of passes_formula=true count.
      let finalCount = count > 0 ? count : (frozenCount ?? 0);
      if (state === "running") {
        try {
          const s = await fetch("/api/dashboard/live-scan/state").then((r) =>
            r.ok ? r.json() : null,
          );
          if (s && typeof s.reads_since_start === "number") finalCount = s.reads_since_start;
        } catch {
          /* fall back to in-state value */
        }
        await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
      }
      // End scan-sessions → readers go cold. Stop the heartbeat. Runs for
      // both the running→stop and paused→stop paths (idempotent if paused
      // already cleared the heartbeat / stopped sessions).
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      await fetch("/api/scan-sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      setFrozenCount(finalCount);
      setFrozenPerAntenna(null); // collapse the grid
      setPerAntenna([]);
      setState("stopped");
    } finally {
      setBusy(false);
    }
  }, [busy, state, count, frozenCount]);

  const live = state === "running";
  // RUNNING shows the live grid; PAUSED shows the frozen grid; STOPPED/IDLE
  // show nothing.
  const gridRows: PerAntennaRow[] =
    state === "running"
      ? perAntenna
      : state === "paused"
        ? (frozenPerAntenna ?? [])
        : [];
  // Sum of disabled readers' EPC contributions — subtracted from the
  // server-authoritative headline so the displayed count reflects only
  // the tiles the operator has left ON. Disabled tiles still tick in
  // the background (re-enabling restores instantly) but don't add to
  // the displayed total.
  const disabledEpcSum = gridRows
    .filter((a) => disabledReaders.has(a.reader_id))
    .reduce((sum, a) => sum + a.unique_epcs, 0);
  const baseCount = live ? count : (frozenCount ?? count);
  const displayCount = Math.max(0, baseCount - disabledEpcSum);
  const disabledCount = disabledReaders.size;

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
          {disabledCount > 0 && state !== "stopped" ? (
            <span className="font-mono text-[0.6rem] uppercase tracking-wide text-amber-400/80">
              · {disabledCount} reader{disabledCount === 1 ? "" : "s"} off (−{disabledEpcSum.toLocaleString()})
            </span>
          ) : null}
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
          {gridRows.map((a) => {
            const off = disabledReaders.has(a.reader_id);
            // STOPPED state: tiles are not interactive (session ended,
            // toggling has no meaning). Otherwise click toggles the
            // reader's contribution in/out of the displayed headline.
            const interactive = state !== "stopped";
            return (
              <button
                key={a.antenna_id}
                type="button"
                onClick={() => interactive && toggleReader(a.reader_id)}
                disabled={!interactive}
                aria-pressed={off}
                title={
                  interactive
                    ? off
                      ? `Click to include ${a.reader_name} in the total`
                      : `Click to exclude ${a.reader_name} from the total`
                    : undefined
                }
                className={
                  "flex items-center justify-between rounded border px-2 py-1.5 text-left transition-colors " +
                  (off
                    ? "border-[var(--wms-border)]/40 bg-[var(--wms-surface-elevated)]/30 opacity-50"
                    : "border-[var(--wms-border)]/60 bg-[var(--wms-surface-elevated)]/60") +
                  (interactive
                    ? " cursor-pointer hover:bg-[var(--wms-surface-elevated)]"
                    : " cursor-default")
                }
              >
                <div className="min-w-0">
                  <div
                    className={
                      "truncate font-mono text-[0.7rem] " +
                      (off ? "text-[var(--wms-muted)] line-through" : "text-[var(--wms-fg)]")
                    }
                  >
                    {a.reader_name}
                  </div>
                  <div className="truncate font-mono text-[0.55rem] text-[var(--wms-muted)]">
                    {off ? "OFF · " : ""}
                    ant #{a.antenna_number}
                    {a.network_address ? ` · ${a.network_address}` : ""}
                  </div>
                </div>
                <div
                  className={
                    "ml-2 font-mono text-base font-semibold tabular-nums " +
                    (off ? "text-[var(--wms-muted)] line-through" : "text-[var(--wms-accent)]")
                  }
                >
                  {a.unique_epcs}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
