import { getSession } from "@/lib/get-session";
import { ActivityHistoryWorkspace } from "@/components/reports/activity-history-workspace";

export const dynamic = "force-dynamic";

export default async function ReportsActivityPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Activity history
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Recent audit log entries for your tenant.
        </p>
      </div>
      <ActivityHistoryWorkspace />
    </div>
  );
}
