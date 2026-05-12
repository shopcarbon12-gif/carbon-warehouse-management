"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Play, Square } from "lucide-react";

/**
 * Live Scan widget — moved out of dashboard's command-center into Hardware
 * Config (2026-05-12). The dashboard now shows a small "Last Scan" pill
 * fed by the persisted live_scan_sessions table; this component owns the
 * actual Start/Stop control + live counter + per-antenna breakdown.
 *
 * Self-contained: polls /api/dashboard/live-scan/state every 500 ms while
 * running, subscribes to /api/edge/stream SSE for incremental ticks,
 * polls /api/dashboard/live-scan/per-antenna every 1 s for the antenna
 * breakdown.
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

export function LiveScanWidget() {
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [perAntenna, setPerAntenna] = useState<PerAntennaRow[]>([]);
  const epcsRef = useRef<Set<string>>(new Set());
  const perAntennaEpcsRef = useRef<Map<string, Set<string>>>(new Map());
  const epcFirstAntennaRef = useRef<Map<string, string>>(new Map());

  // Resume detection on mount — the live-scan session lives server-side
  // in-memory; if a session is already active for this tenant when the
  // page loads, reflect that.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as { active?: boolean; count?: number };
        if (cancelled) return;
        if (j.active) {
          setRunning(true);
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

  // /state polling keeps the server-side session alive AND reconciles the
  // headline counter. 500 ms cadence so the counter ticks fast.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as { active?: boolean; count?: number };
        if (cancelled) return;
        if (!j.active) {
          setRunning(false);
          setCount(0);
          epcsRef.current = new Set();
          return;
        }
        const serverCount = j.count ?? 0;
        setCount((prev) => Math.max(prev, serverCount));
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
  }, [running]);

  // SSE incremental ticks — fan-out from ingestAgentReads. Same pattern
  // as the dashboard widget had: dedupe by EPC into a session-scoped Set,
  // partition by first-attribution antenna.
  useEffect(() => {
    if (!running) {
      epcsRef.current = new Set();
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
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!parsed?.epcs?.length) return;
      if (parsed.scanContext && parsed.scanContext !== "TRANSFER") return;
      const set = epcsRef.current;
      const before = set.size;
      for (const e of parsed.epcs) {
        if (typeof e === "string" && e.length > 0) set.add(e.toUpperCase());
      }
      if (set.size !== before) setCount((p) => Math.max(p, set.size));
      const map = parsed.epcAntennaMap;
      if (map) {
        const touched = new Set<string>();
        for (const epcRaw of Object.keys(map)) {
          const antId = map[epcRaw];
          if (!antId) continue;
          const epc = epcRaw.toUpperCase();
          if (epcFirstAntennaRef.current.has(epc)) continue;
          epcFirstAntennaRef.current.set(epc, antId);
          let s = perAntennaEpcsRef.current.get(antId);
          if (!s) {
            s = new Set<string>();
            perAntennaEpcsRef.current.set(antId, s);
          }
          const sb = s.size;
          s.add(epc);
          if (s.size !== sb) touched.add(antId);
        }
        if (touched.size > 0) {
          setPerAntenna((prev) =>
            prev.map((row) => {
              if (!touched.has(row.antenna_id)) return row;
              const sseCount = perAntennaEpcsRef.current.get(row.antenna_id)?.size ?? 0;
              return sseCount > row.unique_epcs ? { ...row, unique_epcs: sseCount } : row;
            }),
          );
        }
      }
    };
    es.addEventListener("message", onMessage);
    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
    };
  }, [running]);

  // Per-antenna breakdown poll.
  useEffect(() => {
    if (!running) {
      setPerAntenna([]);
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
        const fromApi = j.antennas ?? [];
        setPerAntenna(
          fromApi.map((row) => {
            const sseCount = perAntennaEpcsRef.current.get(row.antenna_id)?.size ?? 0;
            return sseCount > row.unique_epcs ? { ...row, unique_epcs: sseCount } : row;
          }),
        );
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
  }, [running]);

  const onToggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (running) {
        await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
        setRunning(false);
        setCount(0);
        epcsRef.current = new Set();
      } else {
        const res = await fetch("/api/dashboard/live-scan/start", { method: "POST" });
        if (!res.ok) return;
        setCount(0);
        epcsRef.current = new Set();
        setRunning(true);
      }
    } finally {
      setBusy(false);
    }
  }, [running, busy]);

  return (
    <div className="mb-4 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`relative flex h-2.5 w-2.5 rounded-full ${
              running ? "bg-emerald-500" : "bg-[var(--wms-muted)]"
            }`}
            aria-hidden
          >
            {running ? (
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />
            ) : null}
          </span>
          <Radio className="h-4 w-4 text-[var(--wms-accent)]" />
          <span className="font-mono text-sm font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
            Live Scan
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold tabular-nums text-[var(--wms-fg)]">
            {count.toLocaleString()}
          </span>
          <span className="font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">
            unique EPCs
          </span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-sm font-semibold transition-colors ${
            running
              ? "border-red-400/50 bg-red-500/15 text-red-300 hover:bg-red-500/25"
              : "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
          } ${busy ? "opacity-60" : ""}`}
        >
          {running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {running ? "Stop" : "Start"}
        </button>
      </div>
      {running && perAntenna.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
          {perAntenna.map((a) => (
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
