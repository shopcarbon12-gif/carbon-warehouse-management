import { getSession } from "@/lib/get-session";
import { TransferSlipsReportWorkspace } from "@/components/reports/transfers/transfer-slips-report-workspace";

export const dynamic = "force-dynamic";

/**
 * Report view of inbound transfer slips. The action flow lives at
 * /operations/transfers/in — this page is read-only history.
 */
export default async function TransferInReportPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Transfer In (report)</h1>
      </div>
      <TransferSlipsReportWorkspace direction="in" />
    </div>
  );
}
