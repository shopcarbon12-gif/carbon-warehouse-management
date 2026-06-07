import { getSession } from "@/lib/get-session";
import { ScanEpcWorkspace } from "@/components/rfid/scan-epc/scan-epc-workspace";

export const dynamic = "force-dynamic";

export default async function ScanEpcPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Scan EPC
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Pick one or more readers, tune each reader&apos;s power, and live-scan.
          Every unique EPC appears once, tagged with the reader that read it.
          Export the full table (all columns) to CSV.
        </p>
      </div>
      <ScanEpcWorkspace />
    </div>
  );
}
