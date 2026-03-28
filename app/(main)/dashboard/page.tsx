import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { getDashboardKpis } from "@/lib/queries/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return null;

  const kpis = await withDb(
    (sql) => getDashboardKpis(sql, session.tid, session.lid),
    {
      inventory_units: 0,
      order_open: 0,
      exceptions_open: 0,
      sync_pending: 0,
    },
  );

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Dashboard</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Location-scoped KPIs from mirrored inventory, orders, exceptions, and sync jobs.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          href="/inventory"
          label="Inventory units (sum qty)"
          value={kpis.inventory_units}
        />
        <KpiCard href="/orders" label="Open orders" value={kpis.order_open} />
        <KpiCard
          href="/alerts"
          label="Open exceptions"
          value={kpis.exceptions_open}
          warn
        />
        <KpiCard
          href="/sync"
          label="Sync jobs (queued / running / failed)"
          value={kpis.sync_pending}
          danger
        />
      </div>

      <div className="mt-10 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]/60 p-5">
        <h2 className="font-semibold text-[var(--foreground)]">Quick links</h2>
        <p className="mt-2 font-mono text-sm text-[var(--muted)]">
          <Link className="text-[var(--accent)] hover:underline" href="/inventory">
            Inventory
          </Link>
          {" · "}
          <Link className="text-[var(--accent)] hover:underline" href="/compare">
            Compare
          </Link>
          {" · "}
          <Link className="text-[var(--accent)] hover:underline" href="/integrations">
            Integrations
          </Link>
          {" · "}
          <Link className="text-[var(--accent)] hover:underline" href="/handheld">
            Handheld API
          </Link>
        </p>
      </div>
    </div>
  );
}

function KpiCard({
  href,
  label,
  value,
  warn,
  danger,
}: {
  href: string;
  label: string;
  value: number;
  warn?: boolean;
  danger?: boolean;
}) {
  const color = danger
    ? "text-red-300"
    : warn
      ? "text-amber-200"
      : "text-[var(--foreground)]";
  return (
    <Link
      href={href}
      className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--accent-dim)]"
    >
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 font-mono text-xs text-[var(--muted)]">{label}</div>
    </Link>
  );
}
