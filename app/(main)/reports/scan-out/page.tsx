import { getSession } from "@/lib/get-session";
import { ScanOutLogWorkspace } from "@/components/reports/scan-out-log-workspace";

export const dynamic = "force-dynamic";

export default async function ScanOutLogPage() {
  const session = await getSession();
  if (!session) return null;
  return (
    <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Scan-out log</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Everything done on the Scan-out screen — reader started and stopped, every tag scanned out or refused — with
          who, when, the order and the full item as it was at that moment.
        </p>
      </div>
      <ScanOutLogWorkspace />
    </div>
  );
}
