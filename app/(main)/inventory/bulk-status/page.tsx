import { getSession } from "@/lib/get-session";
import { BulkStatusWorkspace } from "@/components/inventory/bulk-status-workspace";

export const dynamic = "force-dynamic";

export default async function BulkStatusPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Bulk status update</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Scan or paste EPCs to move them through the allowed status machine in one batch.
        </p>
      </div>
      <BulkStatusWorkspace />
    </div>
  );
}
