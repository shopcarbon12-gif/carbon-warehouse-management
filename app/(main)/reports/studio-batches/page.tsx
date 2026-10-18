import { getSession } from "@/lib/get-session";
import { StudioBatchesReportWorkspace } from "@/components/reports/studio-batches-report-workspace";

export const dynamic = "force-dynamic";

export default async function StudioBatchesReportPage() {
  const session = await getSession();
  if (!session) return null;
  return (
    <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Studio batches</h1>
        <p className="mt-1 text-sm text-[var(--wms-muted)]">
          Track image batches across products and colours. Finished panels are saved in Dropbox for review in Studio.
        </p>
      </div>
      <StudioBatchesReportWorkspace />
    </div>
  );
}
