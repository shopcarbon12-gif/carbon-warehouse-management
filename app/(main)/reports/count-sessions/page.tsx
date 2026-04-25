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
      </div>
      <CountSessionsWorkspace />
    </div>
  );
}
