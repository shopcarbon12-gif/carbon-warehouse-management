import { getSession } from "@/lib/get-session";
import { BulkGeigerWorkspace } from "@/components/rfid/bulk-geiger/bulk-geiger-workspace";

export const dynamic = "force-dynamic";

export default async function BulkGeigerPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Bulk Geiger</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Upload a CSV / XLSX list of EPCs. Each EPC is auto-resolved to its catalog item; unresolved
          EPCs stay listed as N/A. Select rows and send them to a handheld&apos;s Cloud + Geiger screen
          to physically locate the tags.
        </p>
      </div>
      <BulkGeigerWorkspace />
    </div>
  );
}
