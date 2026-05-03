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
    { refreshInterval: 15_000, revalidateOnFocus: true },
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

  // Poll /state every 1 s while running — updates the counter AND acts as
  // the heartbeat that keeps the server-side session alive. When the tab
  // closes or loses focus, the polling stops and the server session
  // auto-expires within 60 s, telling the agent to idle the readers.
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
          return;
        }
        setLiveScanCount(j.reads_since_start ?? 0);
      } catch {
        /* transient; ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 1_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveScanRunning]);

  // NO auto-start. Tile shows "(click to run)" on mount; operator clicks
  // to begin scanning. The login-page prewarm is allowed to keep running
  // (it warms the radio while the operator types their password) but
  // does NOT visually transition the tile — the click does.

  const onLiveScanClick = useCallback(async () => {
    if (liveScanBusy) return;
    setLiveScanBusy(true);
    try {
      if (liveScanRunning) {
        await fetch("/api/dashboard/live-scan/stop", { method: "POST" });
        setLiveScanRunning(false);
        setLiveScanCount(0);
      } else {
        const res = await fetch("/api/dashboard/live-scan/start", { method: "POST" });
        if (!res.ok) return;
        setLiveScanCount(0);
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
              KPIs refresh every 15s. Live scan opens an SSE listener against every reader
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
              href="/alerts"
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
          <PulsePill
            label="Live scan"
            count={liveScanCount}
            Icon={Radio}
            active={liveScanRunning}
            dim={!liveScanHardwarePresent}
            onClick={liveScanHardwarePresent ? onLiveScanClick : undefined}
            hint={liveScanRunning ? undefined : "(click to run)"}
          />
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

        <div className="mt-4 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-4 py-3.5 font-mono text-base text-[var(--wms-fg)] dark:text-[var(--wms-muted)]">
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
          <Link className="text-[var(--wms-accent)] hover:underline" href="/rfid/commissioning">
            Commissioning
          </Link>
        </div>
      </section>
    </div>
  );
}

