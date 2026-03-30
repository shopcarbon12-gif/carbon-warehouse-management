import { getSession } from "@/lib/get-session";
import { InventoryAuditLogWorkspace } from "@/components/reports/inventory-audit-log-workspace";

export const dynamic = "force-dynamic";

export default async function BulkImportsReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Bulk imports</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Spreadsheet and bulk load events (BULK_IMPORT audit rows).
        </p>
      </div>
      <InventoryAuditLogWorkspace
        logTypes={["BULK_IMPORT"]}
        exportFilePrefix="bulk-import-logs"
        emptyLabel="No bulk import entries yet."
      />
    </div>
  );
}
