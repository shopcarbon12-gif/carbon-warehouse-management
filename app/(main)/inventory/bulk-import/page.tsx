import { redirect } from "next/navigation";
import { BulkImportWorkspace } from "@/components/inventory/bulk-import-workspace";
import { getSession } from "@/lib/get-session";

export const dynamic = "force-dynamic";

export default async function BulkImportPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">
          Bulk Import
        </h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Wake a fixed reader, stream tags that have NEVER been scanned into
          this location, and commit them to inventory as LIVE in one click.
          Tags already in the system at this location are filtered out — this
          page is for brand-new RFID only.
        </p>
      </div>
      <BulkImportWorkspace />
    </div>
  );
}
