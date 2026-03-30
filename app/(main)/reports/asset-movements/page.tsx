import { getSession } from "@/lib/get-session";
import { AssetMovementsWorkspace } from "@/components/reports/asset-movements-workspace";

export const dynamic = "force-dynamic";

export default async function AssetMovementsReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Asset movements</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Physical trail of EPCs between locations (from triggers / scanners).
        </p>
      </div>
      <AssetMovementsWorkspace />
    </div>
  );
}
