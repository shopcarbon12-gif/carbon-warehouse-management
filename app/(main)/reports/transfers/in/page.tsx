import { getSession } from "@/lib/get-session";
import { TransferSlipsWorkspace } from "@/components/inventory/transfer-slips-workspace";

export const dynamic = "force-dynamic";

/**
 * Report view of inbound transfer slips. The action flow lives at
 * /operations/transfers/in — this page is read-only history / reconciliation.
 */
export default async function TransferInReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Transfer in (report)
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Inbound slip history. To receive a pending transfer, use{" "}
          <a href="/operations/transfers/in" className="text-teal-400/90 hover:underline">
            Operations → Transfer In
          </a>
          .
        </p>
      </div>
      <TransferSlipsWorkspace mode="in" />
    </div>
  );
}
