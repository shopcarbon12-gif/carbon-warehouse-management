import { getSession } from "@/lib/get-session";
import { TransferSlipsWorkspace } from "@/components/inventory/transfer-slips-workspace";

export const dynamic = "force-dynamic";

/**
 * Report view of outbound transfer slips. The action flow lives at
 * /operations/transfers/out — this page is read-only history / packing-list export.
 */
export default async function TransferOutReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Transfer out (report)
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Outbound slips & packing-list export. To create a new transfer, use{" "}
          <a href="/operations/transfers/out" className="text-teal-400/90 hover:underline">
            Operations → Transfer Out
          </a>
          .
        </p>
      </div>
      <TransferSlipsWorkspace mode="out" />
    </div>
  );
}
