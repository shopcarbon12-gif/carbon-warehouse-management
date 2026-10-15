import { getSession } from "@/lib/get-session";
import { CountReviewWorkspace } from "@/components/reports/count-review-workspace";

export const dynamic = "force-dynamic";

export default async function CountReviewPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Combine &amp; review a count</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Pick a Count file and the Add-On files scanned against it, check the combined result against the live WMS, then push it once — add to current
          stock, or override the entire stock.
        </p>
      </div>
      <CountReviewWorkspace />
    </div>
  );
}
