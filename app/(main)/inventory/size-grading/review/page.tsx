import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { ScanReviewWorkspace } from "@/components/size-grading/scan-review-workspace";
import { AccuracyChecks } from "@/components/size-grading/accuracy-checks";

export const dynamic = "force-dynamic";

export default async function SizeGradingReviewPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <Link
          href="/inventory/size-grading"
          className="font-mono text-xs text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:inline-flex max-md:min-h-11 max-md:items-center"
        >
          ← Size Grading
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Scan review</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Every photo the CarbonGradingAI app saved, with the lines it measured. Scans with a warning wait under
          &quot;Needs check&quot;. Approve keeps the measurement; Redo takes it back off the items so the size can be
          measured again.
        </p>
      </div>
      <ScanReviewWorkspace />
      <AccuracyChecks />
    </div>
  );
}
