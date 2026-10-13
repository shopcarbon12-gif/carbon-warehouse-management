import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { CutGroupsWorkspace } from "@/components/size-grading/cut-groups-workspace";

export const dynamic = "force-dynamic";

export default async function SizeGradingCutGroupsPage() {
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
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Cut groups</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Products made from the same pattern. Measure one garment per size with the CarbonGradingAI app and the
          numbers go onto every colour of that size and the same size of every product in the group. A product can
          be in one group only.
        </p>
      </div>
      <CutGroupsWorkspace />
    </div>
  );
}
