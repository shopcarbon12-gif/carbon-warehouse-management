"use client";

import useSWR from "swr";
import Link from "next/link";
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
  { label: "Reader", count: 1, icon: Radio },
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
      className={`flex min-w-[7.5rem] items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs ${
        live
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-slate-700/80 bg-zinc-900/60 text-slate-500"
      }`}
    >
      <span
        className={`relative flex h-2 w-2 shrink-0 rounded-full ${
          live ? "bg-emerald-400" : "bg-slate-600"
        }`}
        aria-hidden
      >
        {live ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
        ) : null}
      </span>
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" strokeWidth={2} />
      <div className="min-w-0 leading-tight">
        <div className="text-[0.65rem] uppercase tracking-wide text-slate-500">{label}</div>
        <div className="tabular-nums text-sm font-semibold text-slate-100">{count}</div>
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
  const ring =
    accent === "teal"
      ? "hover:border-teal-500/40 hover:shadow-[0_0_0_1px_rgba(45,212,191,0.15)]"
      : accent === "amber"
        ? "hover:border-amber-500/35 hover:shadow-[0_0_0_1px_rgba(251,191,36,0.12)]"
        : "hover:border-violet-500/35 hover:shadow-[0_0_0_1px_rgba(167,139,250,0.12)]";
  const num =
    accent === "teal"
      ? "text-teal-300"
      : accent === "amber"
        ? "text-amber-200"
        : "text-violet-200";
  return (
    <Link
      href={href}
      className={`block rounded-lg border border-slate-800 bg-zinc-950/80 p-5 transition-colors ${ring}`}
    >
      <div className={`text-3xl font-bold tabular-nums ${num}`}>{value}</div>
      <div className="mt-2 font-mono text-[0.7rem] uppercase tracking-wider text-slate-500">
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

  const kpis = data?.kpis ?? {
    total_items: 0,
    receiving_concerns: 0,
    unknown_assets: 0,
  };
  const activity = data?.activity ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-2 border-b border-slate-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-slate-500">
            <Cpu className="h-4 w-4" strokeWidth={2} />
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em]">
              Command center
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-100">
            Operations overview
          </h1>
          <p className="mt-1 max-w-xl font-mono text-xs text-slate-500">
            Live KPIs refresh every 15s. Hardware pulse reflects fixed edge layout (Senitron-style
            density).
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[0.65rem] text-slate-500">
          {isValidating && !isLoading ? (
            <span className="text-teal-500/80">Syncing…</span>
          ) : null}
          {error ? <span className="text-red-400/90">KPI load error</span> : null}
        </div>
      </div>

      <section>
        <h2 className="mb-3 flex items-center gap-2 font-mono text-[0.7rem] font-medium uppercase tracking-wider text-slate-400">
          <Activity className="h-3.5 w-3.5" strokeWidth={2} />
          Hardware pulse
        </h2>
        <div className="flex flex-wrap gap-2">
          {hardware.map((h) => (
            <PulsePill key={h.label} label={h.label} count={h.count} Icon={h.icon} />
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <section className="space-y-3">
          <h2 className="font-mono text-[0.7rem] font-medium uppercase tracking-wider text-slate-400">
            KPI grid
          </h2>
          {isLoading && !data ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-28 animate-pulse rounded-lg border border-slate-800 bg-zinc-900/50"
                />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
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

          <div className="rounded-lg border border-slate-800 bg-zinc-950/60 px-4 py-3 font-mono text-xs text-slate-500">
            <Link className="text-teal-500/90 hover:underline" href="/inventory">
              Inventory
            </Link>
            {" · "}
            <Link className="text-teal-500/90 hover:underline" href="/compare">
              Compare
            </Link>
            {" · "}
            <Link className="text-teal-500/90 hover:underline" href="/integrations">
              Integrations
            </Link>
            {" · "}
            <Link className="text-teal-500/90 hover:underline" href="/rfid/commissioning">
              Commissioning
            </Link>
          </div>
        </section>

        <aside className="rounded-lg border border-slate-800 bg-zinc-950/80">
          <div className="border-b border-slate-800 px-4 py-3">
            <h2 className="flex items-center gap-2 font-mono text-[0.7rem] font-semibold uppercase tracking-wider text-slate-300">
              <Package className="h-3.5 w-3.5 text-slate-500" strokeWidth={2} />
              Recent activity
            </h2>
            <p className="mt-1 font-mono text-[0.65rem] text-slate-600">Last 10 audit rows</p>
          </div>
          <ul className="max-h-[min(70vh,28rem)] divide-y divide-slate-800/80 overflow-y-auto p-2">
            {activity.length === 0 ? (
              <li className="px-2 py-8 text-center font-mono text-xs text-slate-600">
                No audit events yet.
              </li>
            ) : (
              activity.map((row) => (
                <li key={row.id} className="px-2 py-2.5">
                  <p className="font-mono text-[0.7rem] leading-snug text-slate-300">
                    {formatAuditLine(row)}
                  </p>
                  <p className="mt-1 font-mono text-[0.6rem] tabular-nums text-slate-600">
                    {new Date(row.created_at).toLocaleString()}
                  </p>
                </li>
              ))
            )}
          </ul>
        </aside>
      </div>
    </div>
  );
}
