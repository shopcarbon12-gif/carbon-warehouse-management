import { getSession } from "@/lib/get-session";
import { isSuperAdminRole } from "@/lib/auth/roles";
import { BulkStatusWorkspace } from "@/components/inventory/bulk-status-workspace";

export const dynamic = "force-dynamic";

export default async function BulkStatusPage() {
  const session = await getSession();
  if (!session) return null;

  const superAdmin = isSuperAdminRole(session.role);

  return (
    <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Bulk status update</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Clean 10 vocabulary — paste EPCs and pick a target status. Super Admin can override locked rows and
          system workflow states.
        </p>
      </div>
      <BulkStatusWorkspace isSuperAdmin={superAdmin} />
    </div>
  );
}
