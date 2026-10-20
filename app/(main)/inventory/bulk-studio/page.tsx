import { getSession } from "@/lib/get-session";
import { BulkStudioWorkspace } from "@/components/inventory/bulk-studio/bulk-studio-workspace";

export const dynamic = "force-dynamic";

export default async function BulkStudioPage() {
  const session = await getSession();
  if (!session) return null;
  /* Same rule as the Studio tab in the catalog: admins manage; the Studio APIs
     themselves require the admin scope. */
  const canManage = session.role?.trim().toLowerCase() === "admin";

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Bulk Studio</h1>
        <p className="mt-1 max-w-3xl font-mono text-xs text-[var(--wms-muted)]">
          Set up many products at once with the Studio&apos;s own tools — photos, jeans label, model, item type, colour and
          instructions. Analyze all reads every item&apos;s photos exactly as the Studio tab does; Send batch sends all four
          panels of every ready item to OpenAI as one batch, at half price. Each product&apos;s photos and spec are the same ones
          its Studio tab shows.
        </p>
      </div>
      {canManage ? (
        <BulkStudioWorkspace canManage={canManage} />
      ) : (
        <p className="font-mono text-xs text-[var(--wms-status-warning-fg)]">Bulk Studio is for admins.</p>
      )}
    </div>
  );
}
