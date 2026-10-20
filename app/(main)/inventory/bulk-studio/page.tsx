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
    <div className="flex w-full min-w-0 flex-col gap-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Bulk Studio</h1>
      </div>
      {canManage ? (
        <BulkStudioWorkspace canManage={canManage} />
      ) : (
        <p className="font-mono text-xs text-[var(--wms-status-warning-fg)]">Bulk Studio is for admins.</p>
      )}
    </div>
  );
}
