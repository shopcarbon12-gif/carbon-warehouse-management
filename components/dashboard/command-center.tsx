"use client";

import useSWR from "swr";
import Link from "next/link";
import { useCallback, useState } from "react";
import {
  Activity,
  Cpu,
  Package,
  Printer,
  Radio,
  Smartphone,
  Wifi,
} from "lucide-react";
import type { AuditLogListRow } from "@/lib/queries/dashboard-command";
import { LiveStreamHandler } from "@/components/rfid/live-stream-handler";

type CommandPayload = {
  kpis: {
    total_items: number;
    receiving_concerns: number;
    unknown_assets: number;
  };
  activity: AuditLogListRow[];
};

const fetcher = async (url: string): Promise<CommandPayload> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to load dashboard");
  }
  return res.json() as Promise<CommandPayload>;
};

const hardware = [
  { label: "Readers", count: 1, icon: Radio },
  { label: "Antennas", count: 9, icon: Wifi },
  { label: "Printers", count: 1, icon: Printer },
  { label: "Handhelds", count: 0, icon: Smartphone },
] as const;

function PulsePill({
  label,
  count,
  Icon,
}: {
  label: string;
  count: number;
  Icon: typeof Radio;
}) {
  const live = count > 0;
  return (
    <div
      className={`flex min-w-[6.5rem] flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 font-mono text-xs sm:min-w-[7.5rem] ${
        live
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
          className={`text-[0.6rem] uppercase tracking-wide ${live ? "text-emerald-900/85 dark:text-emerald-200/90" : "text-[var(--wms-muted)]"}`}
        >
          {label}
        </div>
        <div className="tabular-nums text-sm font-semibold text-[var(--wms-fg)]">{count}</div>
      </div>
    </div>
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
      className={`block rounded-xl border p-5 shadow-sm transition-colors ${skin.card}`}
    >
      <div className={`text-3xl font-bold tabular-nums ${skin.num}`}>{value}</div>
      <div className={`mt-2 font-mono text-[0.65rem] uppercase tracking-wider ${skin.label}`}>{title}</div>
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
  const [liveScanCount, setLiveScanCount] = useState(0);

  const onLiveScan = useCallback((delta: number) => {
    setLiveScanCount((c) => c + Math.max(0, delta));
  }, []);

  const { data, error, isLoading, isValidating } = useSWR(
    "/api/dashboard/command",
    fetcher,
    { refreshInterval: 15_000, revalidateOnFocus: true },
  );

  const kpis = data?.kpis ?? {
    total_items: 0,
    receiving_concerns: 0,
    unknown_assets: 0,
  };
  const activity = data?.activity ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <LiveStreamHandler onLiveScanCount={onLiveScan} />

      <header className="border-b border-[var(--wms-border)] pb-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[var(--wms-secondary)]">
              <Cpu className="h-4 w-4 text-[var(--wms-accent)]" strokeWidth={2} />
              <span className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.2em]">Command center</span>
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--wms-fg)]">
              Operations overview
            </h1>
            <p className="mt-1 max-w-xl font-mono text-xs text-[var(--wms-muted)]">
              KPIs refresh every 15s. RFID edge stream (SSE) updates the live scan counter for this session.
            </p>
          </div>
          <div className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
            {isValidating && !isLoading ? <span className="text-[var(--wms-accent)]">Syncing…</span> : null}
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
              value={kpis.total_items}
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
              title="Unknown assets"
              value={kpis.unknown_assets}
              href="/inventory"
              accent="violet"
            />
          </div>
        )}
      </section>

      {/* Middle: hardware pulse */}
      <section aria-label="Hardware pulse">
        <h2 className="mb-3 flex items-center gap-2 border-b border-[var(--wms-border)] pb-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-[var(--wms-secondary)]">
          <Radio className="h-3.5 w-3.5 text-[var(--wms-accent)]" strokeWidth={2} />
          Hardware pulse
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <PulsePill label="Live scans (session)" count={liveScanCount} Icon={Radio} />
          {hardware.map((h) => (
            <PulsePill key={h.label} label={h.label} count={h.count} Icon={h.icon} />
          ))}
        </div>
      </section>

      {/* Bottom: recent activity timeline */}
      <section aria-label="Recent activity">
        <h2 className="mb-3 flex items-center gap-2 border-b border-[var(--wms-border)] pb-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-[var(--wms-secondary)]">
          <Activity className="h-3.5 w-3.5 text-[var(--wms-accent)]" strokeWidth={2} />
          Recent activity
        </h2>
        <div className="rounded-xl border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_6%,var(--wms-surface))] shadow-sm dark:bg-[var(--wms-surface)]">
          <div className="border-b border-[var(--wms-border)] px-4 py-3">
            <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
              Last 10 audit events ·{" "}
              <Link href="/reports/activity" className="text-[var(--wms-accent)] hover:underline">
                View all
              </Link>
            </p>
          </div>
          <ul className="divide-y divide-[var(--wms-border)]/80">
            {activity.length === 0 ? (
              <li className="px-4 py-10 text-center font-mono text-xs text-[var(--wms-muted)]">
                No audit events yet.
              </li>
            ) : (
              activity.map((row, i) => (
                <li key={row.id} className="relative flex gap-4 px-4 py-3 pl-8">
                  <span
                    className="absolute left-3 top-4 h-2 w-2 rounded-full bg-[var(--wms-accent)] ring-4 ring-[var(--wms-surface)]"
                    aria-hidden
                  />
                  {i < activity.length - 1 ? (
                    <span
                      className="absolute bottom-0 left-[0.8rem] top-8 w-px bg-[var(--wms-border)]"
                      aria-hidden
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs leading-snug text-[var(--wms-fg)]">
                      {formatAuditLine(row)}
                    </p>
                    <p className="mt-1 font-mono text-[0.6rem] tabular-nums text-[var(--wms-muted)]">
                      {new Date(row.created_at).toLocaleString()}
                    </p>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="mt-4 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-4 py-3 font-mono text-xs text-[var(--wms-fg)] dark:text-[var(--wms-muted)]">
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
