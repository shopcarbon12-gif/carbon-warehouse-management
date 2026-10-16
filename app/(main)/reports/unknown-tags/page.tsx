import { getSession } from "@/lib/get-session";
import { UnknownTagsWorkspace } from "@/components/reports/unknown-tags-workspace";

export const dynamic = "force-dynamic";

export default async function UnknownTagsReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">New Unknown tags</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Tags a count or reader found that were never recorded in the WMS. They stay Unknown until you check them
          with Cloud + Geiger and change them to Live.
        </p>
      </div>
      <UnknownTagsWorkspace />
    </div>
  );
}
