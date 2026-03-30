import { getSession } from "@/lib/get-session";
import { ExternalSystemsReportWorkspace } from "@/components/reports/external-systems-report-workspace";

export const dynamic = "force-dynamic";

export default async function ExternalSystemsReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">External systems</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Inbound webhooks and outbound API calls to vendors and integrations.
        </p>
      </div>
      <ExternalSystemsReportWorkspace />
    </div>
  );
}
