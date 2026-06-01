"use client";

import useSWR from "swr";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  Printer,
  Radio,
  Smartphone,
  Wifi,
} from "lucide-react";
import type { AuditLogListRow } from "@/lib/queries/dashboard-command";
import { useCountUp } from "./use-count-up";

type HardwareCounts = {
  readers: number;
  antennas: number;
  printers: number;
  handhelds: number;
};

type Kpis = {
  live_inventory: number;
  total_items: number;
  receiving_concerns: number;
  defective_epcs: number;
  unknown_assets: number;
  hardware: HardwareCounts;
  has_scannable_hardware: boolean;
};

type CommandPayload = {
  kpis: Kpis;
  activity: AuditLogListRow[];
};

type LookupRow = {
  epc: string;
  status: string;
};

const fetcher = async (url: string): Promise<CommandPayload> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to load dashboard");
  }
  return res.json() as Promise<CommandPayload>;
};

async function postLookup(epcs: string[]): Promise<LookupRow[]> {
  const res = await fetch("/api/operations/transfers/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epcs }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { rows?: LookupRow[] };
  return data.rows ?? [];
}

/**
 * Read-only "Last Scan" pill. Fetches the most recently-completed live-scan
 * session from /api/dashboard/last-live-scan (backed by the persisted
 * live_scan_sessions table). Replaces the in-place Live Scan control on the
 * dashboard — that's moved to Hardware Config (2026-05-12).
 */
function LastScanPill() {
  const [data, setData] = useState<{
    started_at: string;
    ended_at: string;
    unique_epc_count: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/last-live-scan");
        if (!res.ok) return;
        const j = (await res.json()) as { last_scan: typeof data | null };
        if (cancelled) return;
        setData(j.last_scan ?? null);
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  const hint = data
    ? new Date(data.ended_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "(no scans yet)";
  return (
    <PulsePill
      label="Last scan"
      count={data?.unique_epc_count ?? 0}
      Icon={Radio}
      hint={data ? undefined : hint}
    />
  );
}

function PulsePill({
  label,
  count,
  Icon,
  active,
  dim,
  onClick,
  hint,
}: {
  label: string;
  count: number;
  Icon: typeof Radio;
  active?: boolean;
  dim?: boolean;
  /** When provided, the pill renders as a button (master-toggle behavior). */
  onClick?: () => void;
  /** Replaces the count when set (e.g. "(click to run)" in IDLE state). */
  hint?: string;
}) {
  const live = (active ?? count > 0) && !dim;
  const animated = useCountUp(count);
  const Cmp = onClick ? "button" : "div";
  return (
    <Cmp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`flex min-w-[7.25rem] flex-1 items-center gap-2 rounded-lg border px-3 py-3.5 font-mono text-base sm:min-w-[8rem] ${
        onClick ? "cursor-pointer text-left transition-colors hover:brightness-110" : ""
      } ${
        dim
          ? "border-[var(--wms-border)]/60 bg-[var(--wms-surface-elevated)]/40 text-[var(--wms-muted)]"
          : live
            ? "border-emerald-700/45 bg-[color-mix(in_srgb,#059669_32%,var(--wms-surface-elevated))] text-emerald-950 shadow-sm dark:border-emerald-500/45 dark:bg-[color-mix(in_srgb,#10b981_22%,var(--wms-surface-elevated))] dark:text-emerald-100"
            : "border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] text-[var(--wms-fg)] dark:bg-[var(--wms-surface-elevated)]"
      }`}
    >
      <span
        className={`relative flex h-2 w-2 shrink-0 rounded-full ${
          live ? "bg-emerald-600 dark:bg-emerald-400" : "bg-[var(--wms-muted)]"
        }`}
        aria-hidden
      >
        {live ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/70 dark:bg-emerald-400/60" />
        ) : null}
      </span>
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" strokeWidth={2} />
      <div className="min-w-0 leading-tight">
        <div
          className={`text-xs font-semibold uppercase tracking-wide ${
            dim
              ? "text-[var(--wms-muted)]"
              : live
                ? "text-emerald-900 dark:text-emerald-200/90"
                : "text-[var(--wms-muted)]"
          }`}
        >
          {label}
        </div>
        {hint ? (
          <div className="text-[0.6rem] font-medium uppercase tracking-wide text-[var(--wms-fg)]">
            {hint}
          </div>
        ) : (
          <div className="tabular-nums text-base font-bold text-[var(--wms-fg)]">
            {animated}
          </div>
        )}
      </div>
    </Cmp>
  );
}

function KpiTile({
  title,
  value,
  href,
  accent,
}: {
  title: string;
  value: number;
  href: string;
  accent: "teal" | "amber" | "violet";
}) {
  const animated = useCountUp(value);
  const skin =
    accent === "teal"
      ? {
          card: "border-[color-mix(in_srgb,var(--wms-accent)_45%,var(--wms-border))] bg-[color-mix(in_srgb,var(--wms-accent)_26%,var(--wms-surface-elevated))] hover:border-[var(--wms-accent)]/55 dark:border-[var(--wms-accent)]/35 dark:bg-[color-mix(in_srgb,var(--wms-accent)_16%,var(--wms-surface))]",
          num: "text-[color-mix(in_srgb,var(--wms-accent)_12%,#042f2e)] dark:text-[var(--wms-accent)]",
          label: "text-[color-mix(in_srgb,var(--wms-fg)_78%,var(--wms-accent))] dark:text-[var(--wms-muted)]",
        }
      : accent === "amber"
        ? {
            card: "border-amber-700/35 bg-[color-mix(in_srgb,#b45309_24%,var(--wms-surface-elevated))] hover:border-amber-700/50 dark:border-amber-500/35 dark:bg-[color-mix(in_srgb,#d97706_18%,var(--wms-surface))]",
            num: "text-amber-950 dark:text-amber-200",
            label: "text-amber-950/80 dark:text-[var(--wms-muted)]",
          }
        : {
            card: "border-violet-700/35 bg-[color-mix(in_srgb,#6d28d9_22%,var(--wms-surface-elevated))] hover:border-violet-700/50 dark:border-violet-500/35 dark:bg-[color-mix(in_srgb,#7c3aed_16%,var(--wms-surface))]",
            num: "text-violet-950 dark:text-violet-200",
            label: "text-violet-950/80 dark:text-[var(--wms-muted)]",
          };
  return (
    <Link
      href={href}
      className={`block rounded-xl border p-6 shadow-sm transition-colors ${skin.card}`}
    >
      <div className={`text-4xl font-bold tabular-nums ${skin.num}`}>{animated}</div>
      <div className={`mt-2.5 font-mono text-base font-semibold uppercase tracking-wider ${skin.label}`}>
        {title}
      </div>
    </Link>
  );
}

function formatAuditLine(row: AuditLogListRow): string {
  const bits: string[] = [row.action, row.entity].filter(Boolean);
  if (row.metadata && typeof row.metadata === "object" && row.metadata !== null) {
    const m = row.metadata as Record<string, unknown>;
    const summary = m.summary ?? m.detail ?? m.label;
    if (typeof summary === "string" && summary.length < 80) {
      bits.push(`— ${summary}`);
    }
  }
  return bits.join(" · ");
}

export function CommandCenter() {
  const { data, error, isLoading, isValidating } = useSWR(
    "/api/dashboard/command",
    fetcher,
    // 3s refresh (was 15s) so KPI tiles (live_inventory, total_items,
    // receiving_concerns, hardware counts) reflect floor activity within
    // a few seconds instead of feeling stale during an active scan.
    // /api/dashboard/command is a roll-up SELECT; cheap to call.
    { refreshInterval: 3_000, revalidateOnFocus: true },
  );

  const kpis: Kpis =
    data?.kpis ?? {
      live_inventory: 0,
      total_items: 0,
      receiving_concerns: 0,
      defective_epcs: 0,
      unknown_assets: 0,
      hardware: { readers: 0, antennas: 0, printers: 0, handhelds: 0 },
      has_scannable_hardware: false,
    };
  const activity = data?.activity ?? [];

  const hardwareTotal =
    kpis.hardware.readers +
    kpis.hardware.antennas +
    kpis.hardware.printers +
    kpis.hardware.handhelds;
  // Gate the Live scan tile on CONFIGURED readers, not real-time activity.
  // Earlier this was `kpis.hardware.readers + kpis.hardware.antennas > 0` —
  // but those counts now reflect "produced reads in the last 60 s." When
  // scanning is OFF (the default after `b331061`), both are 0, so the tile
  // was permanently un-clickable. The operator could see "(click to run)"
  // but the click was a no-op. has_scannable_hardware stays true while any
  // reader is configured at this location, regardless of activity.
  const liveScanHardwarePresent = kpis.has_scannable_hardware;

  // Live scan tile is the master ON/OFF toggle for fixed-reader scanning.
  // IDLE on landing — readers paused server-side.
  // Click → POST /start → RUNNING → polls /state every 2 s for counter +
  //   to keep the server-side session alive (the GET refreshes lastSeenAt).
  // Click again → POST /stop → IDLE (counter back to 0; readers stop).
  // Tab close / refresh / no internet → polls stop → server auto-expires
  //   the session at 60 s → readers stop.
  // suppress unused-import lint until we re-enable lookup-side filtering
  void postLookup;
  const [liveScanRunning, setLiveScanRunning] = useState(false);
  const [liveScanCount, setLiveScanCount] = useState(0);
  const [liveScanBusy, setLiveScanBusy] = useState(false);
  // Session-scoped Set of unique EPCs the SSE stream has delivered. The
  // headline counter is the max of (this Set's size, the server's
  // count-since-start). SSE drives smooth incremental ticks; the poll
  // periodically reconciles to the server's count(DISTINCT) of decoded
  // reads, never moving the counter backwards. Cleared on every
  // start→stop transition.
  const liveScanEpcsRef = useRef<Set<string>>(new Set());

  // Per-antenna session-scoped Set<EPC>. Same SSE stream as the headline,
  // but partitioned by antenna_id so each row's count ticks instantly
  // instead of waiting for the next 1-s poll. Reconciled upward against
  // the server's per-antenna SQL on every poll cycle.
  //
  // FIRST-ANTENNA ATTRIBUTION: each EPC is added to AT MOST ONE antenna's
  // set — the first antenna that the SSE stream tells us decoded it this
  // session. Mirrors the server-side WITH first_attribution CTE in
  // /api/dashboard/live-scan/per-antenna so the SSE-driven ticks and the
  // 1-s poll never disagree on which antenna owns an EPC. Without this,
  // multi-antenna readers (e.g. Transfer Bin's supervisor mux) would have
  // each antenna's tile climb toward the headline total once both
  // antennas had seen the same tags — which violates the "sum of per-
  // antenna = total unique" expectation operators have on the dashboard.
  const perAntennaEpcsRef = useRef<Map<string, Set<string>>>(new Map());
  // EPC → antenna_id of first SSE sighting this session. Cleared with the
  // session sets on every start→stop transition. Lookup avoids touching
  // perAntennaEpcsRef when we already know the EPC is attributed.
  const epcFirstAntennaRef = useRef<Map<string, string>>(new Map());

  // Poll /state every 500 ms while running — updates the counter (via
  // upward-only reconciliation) AND acts as the heartbeat that keeps the
  // server-side session alive. When the tab closes or loses focus, the
  // polling stops and the server session auto-expires within 60 s,
  // telling the agent to idle the readers.
  useEffect(() => {
    if (!liveScanRunning) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/state");
        if (!res.ok) return;
        const j = (await res.json()) as {
          active: boolean;
          reads_since_start?: number;
        };
        if (cancelled) return;
        if (!j.active) {
          // Session expired server-side (e.g. WMS restart). Drop back to IDLE.
          setLiveScanRunning(false);
          setLiveScanCount(0);
          liveScanEpcsRef.current = new Set();
          return;
        }
        const serverCount = j.reads_since_start ?? 0;
        // Upward-only: never let the poll roll the counter back below
        // what SSE has already shown. Server is authoritative for the
        // true high-water mark (count(DISTINCT) of decoded reads); SSE
        // can transiently be ahead during a burst before the DB query
        // catches up, OR ahead by EPCs that didn't pass_formula.
        setLiveScanCount((prev) => Math.max(prev, serverCount));
      } catch {
        /* transient; ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveScanRunning]);

  // SSE-driven incremental counter. Subscribes to the same edge stream
  // that powers LiveStreamHandler — this hub is fan-out from
  // ingestAgentReads (fixed readers) and inventory-reconciler (handhelds).
  // Filter to the TRANSFER scanContext that fixed-reader agent ingest
  // publishes. Each event carries a deduped batch of EPCs; we accumulate
  // session-unique EPCs in a ref-Set and update the headline counter
  // with the new size. End-to-end latency from reader stdout to UI tick
  // is ~250 ms (aggregator flush) vs ~500 ms via DB poll.
  useEffect(() => {
    if (!liveScanRunning) {
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
      // Handheld scans use other contexts; ignore them for the
      // live-scan tile (it's the master toggle for FIXED readers).
      if (parsed.scanContext && parsed.scanContext !== "TRANSFER") return;
      const set = liveScanEpcsRef.current;
      const beforeSize = set.size;
      for (const e of parsed.epcs) {
        if (typeof e === "string" && e.length > 0) set.add(e.toUpperCase());
      }
      if (set.size !== beforeSize) {
        const newSize = set.size;
        setLiveScanCount((prev) => (newSize > prev ? newSize : prev));
      }
      // Per-antenna SSE accumulator — same stream, partitioned by antenna.
      // First-antenna attribution: each EPC is added to AT MOST ONE
      // antenna's set, the first one we see for it this session.
      // Subsequent sightings on other antennas do not increment any tile.
      // Mirrors the server CTE so SSE ticks and 1-s poll never disagree.
      const map = parsed.epcAntennaMap;
      if (map) {
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
  }, [liveScanRunning]);

  // Per-antenna breakdown of unique EPCs in this session — polled every 2 s
  // while live-scan is running. Sums across antennas align with the headline
  // counter (both filter to items currently in-stock).
  const [perAntenna, setPerAntenna] = useState<
    {
      reader_id: string;
      reader_name: string;
      antenna_id: string;
      antenna_name: string;
      antenna_number: number;
      network_address: string | null;
      unique_epcs: number;
    }[]
  >([]);
  useEffect(() => {
    if (!liveScanRunning) {
      setPerAntenna([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/live-scan/per-antenna");
        if (!res.ok) return;
        const j = (await res.json()) as {
          active: boolean;
          antennas?: typeof perAntenna;
        };
        if (cancelled) return;
        if (!j.active) {
          setPerAntenna([]);
          return;
        }
        // Upward-only merge with the SSE accumulator — the SSE stream may
        // be transiently ahead of the DB poll during a burst, so prefer
        // whichever number is higher. Same pattern the headline counter
        // uses against /state.
        const fromApi = j.antennas ?? [];
        setPerAntenna(
          fromApi.map((row) => {
            const sseCount = perAntennaEpcsRef.current.get(row.antenna_id)?.size ?? 0;
            return sseCount > row.unique_epcs
              ? { ...row, unique_epcs: sseCount }
              : row;
          }),
        );
      } catch {
        /* transient; ignore */
      }
    };
    void tick();
    // 1 s polling on the per-antenna table (was 2 s) so an antenna's
    // live count updates twice as often. The route LATERAL-joins one
    // count per antenna, scaling linearly with antenna count; trivial
    // load even at 50+ antennas. Applies to every antenna on every
    // reader, including ones added in the future — the route SELECTs
    // all antennas in `devices` for the tenant.
    const id = setInterval(tick, 1_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveScanRunning]);

  // Live scan default: IDLE on every page load. Removed the mount-time
  // auto-start (it used to call /start when the operator's public IP
  // matched the agent's last_known_public_ip) — tile only goes to RUNNING
  // when the user clicks it.

  const onLiveScanClick = useCallback(async () => {
    if (liveScanBusy) return;
    setLiveScanBusy(true);
    try {
      if (liveScanRunning) {
        await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
        setLiveScanRunning(false);
        setLiveScanCount(0);
        liveScanEpcsRef.current = new Set();
      } else {
        const res = await fetch("/api/dashboard/live-scan/start", { method: "POST" });
        if (!res.ok) return;
        setLiveScanCount(0);
        liveScanEpcsRef.current = new Set();
        setLiveScanRunning(true);
      }
    } finally {
      setLiveScanBusy(false);
    }
  }, [liveScanRunning, liveScanBusy]);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="border-b border-[var(--wms-border)] pb-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[var(--wms-secondary)]">
              <Cpu className="h-4 w-4 text-[var(--wms-accent)]" strokeWidth={2} />
              <span className="font-mono text-sm font-semibold uppercase tracking-[0.18em]">
                Command center
              </span>
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--wms-fg)]">
              Operations overview
            </h1>
            <p className="mt-1 max-w-xl font-mono text-sm text-[var(--wms-muted)]">
              KPIs refresh every 3s. Live scan opens an SSE listener against every reader
              and antenna at this location.
            </p>
          </div>
          <div className="font-mono text-sm text-[var(--wms-muted)]">
            {isValidating && !isLoading ? (
              <span className="text-[var(--wms-accent)]">Syncing…</span>
            ) : null}
            {error ? <span className="text-red-500/90">KPI load error</span> : null}
          </div>
        </div>
      </header>

      {/* Top: KPI cards */}
      <section aria-label="Key metrics">
        {isLoading && !data ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-xl border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_10%,var(--wms-surface-elevated))]"
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiTile
              title="Total active inventory"
              value={kpis.live_inventory}
              href="/inventory/catalog"
              accent="teal"
            />
            <KpiTile
              title="Receiving concerns"
              value={kpis.receiving_concerns}
              href="/inventory/transfers/in"
              accent="amber"
            />
            <KpiTile
              title="Defective EPCs"
              value={kpis.defective_epcs}
              href="/inventory/catalog"
              accent="violet"
            />
          </div>
        )}
      </section>

      {/* Middle: hardware pulse */}
      <section aria-label="Hardware pulse">
        <h2 className="mb-3 flex items-center gap-2 border-b border-[var(--wms-border)] pb-2 font-mono text-base font-semibold uppercase tracking-[0.1em] text-[var(--wms-fg)]">
          <Radio className="h-5 w-5 text-[var(--wms-accent)]" strokeWidth={2} />
          Hardware pulse
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <LastScanPill />
          {/*
            Live Scan moved to Hardware Config (2026-05-12) — the Start/Stop
            control + counter + per-antenna detail now live at the top of
            /hardware-config. Dashboard shows the LAST completed session's
            unique-EPC total, sourced from the persisted live_scan_sessions
            table so it survives server restarts.
          */}
          <PulsePill label="Readers" count={kpis.hardware.readers} Icon={Radio} />
          <PulsePill label="Antennas" count={kpis.hardware.antennas} Icon={Wifi} />
          <PulsePill label="Printers" count={kpis.hardware.printers} Icon={Printer} />
          <PulsePill label="Handhelds" count={kpis.hardware.handhelds} Icon={Smartphone} />
        </div>
        {hardwareTotal === 0 ? (
          <p className="mt-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
            No hardware configured at this location — Live scan is disabled.
          </p>
        ) : null}
        {/* Per-antenna detail moved to Hardware Config along with the Live Scan widget. */}
      </section>

      {/* Bottom: recent activity timeline */}
      <section aria-label="Recent activity">
        <h2 className="mb-3 flex items-center gap-2 border-b border-[var(--wms-border)] pb-2 font-mono text-base font-semibold uppercase tracking-[0.1em] text-[var(--wms-fg)]">
          <Activity className="h-5 w-5 text-[var(--wms-accent)]" strokeWidth={2} />
          Recent activity
        </h2>
        <div className="rounded-xl border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_6%,var(--wms-surface))] shadow-sm dark:bg-[var(--wms-surface)]">
          <div className="border-b border-[var(--wms-border)] px-4 py-3">
            <p className="font-mono text-base text-[color-mix(in_srgb,var(--wms-fg)_72%,var(--wms-muted))]">
              Last 10 audit events ·{" "}
              <Link href="/reports/activity" className="text-[var(--wms-accent)] hover:underline">
                View all
              </Link>
            </p>
          </div>
          <div className="border-b border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-4 py-3.5 font-mono text-base text-[var(--wms-fg)] dark:text-[var(--wms-muted)]">
            <Link className="text-[var(--wms-accent)] hover:underline" href="/inventory">
              Inventory
            </Link>
            {" · "}
            <Link className="text-[var(--wms-accent)] hover:underline" href="/compare">
              Compare
            </Link>
            {" · "}
            <Link className="text-[var(--wms-accent)] hover:underline" href="/integrations">
              Integrations
            </Link>
            {" · "}
            <Link className="text-[var(--wms-accent)] hover:underline" href="/tags-labels/print">
              Print tags
            </Link>
          </div>
          <ul className="divide-y divide-[var(--wms-border)]/80">
            {activity.length === 0 ? (
              <li className="px-4 py-10 text-center font-mono text-base text-[var(--wms-muted)]">
                No audit events yet.
              </li>
            ) : (
              activity.map((row, i) => (
                <li key={row.id} className="relative flex gap-4 px-4 py-3.5 pl-9">
                  <span
                    className="absolute left-3.5 top-[1.15rem] h-2.5 w-2.5 rounded-full bg-[var(--wms-accent)] ring-4 ring-[var(--wms-surface)]"
                    aria-hidden
                  />
                  {i < activity.length - 1 ? (
                    <span
                      className="absolute bottom-0 left-[0.95rem] top-9 w-px bg-[var(--wms-border)]"
                      aria-hidden
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-base leading-snug text-[var(--wms-fg)]">
                      {formatAuditLine(row)}
                    </p>
                    <p className="mt-1.5 font-mono text-sm tabular-nums text-[color-mix(in_srgb,var(--wms-fg)_62%,var(--wms-muted))]">
                      {new Date(row.created_at).toLocaleString()}
                    </p>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>

      </section>
    </div>
  );
}

