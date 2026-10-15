import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { CountSessionsWorkspace } from "@/components/reports/count-sessions-workspace";

export const dynamic = "force-dynamic";

export default async function CountSessionsReportsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Count session reports
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Audit archive of handheld count sessions (intent-driven uploads, retained 1 year).
        </p>
        <Link
          href="/reports/count-sessions/review"
          className="mt-3 inline-flex rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 max-md:min-h-11"
        >
          Combine &amp; review a count → push
        </Link>
      </div>
      <CountSessionsWorkspace />
    </div>
  );
}
