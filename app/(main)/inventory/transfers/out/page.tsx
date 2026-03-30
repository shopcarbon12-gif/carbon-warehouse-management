import { getSession } from "@/lib/get-session";
import { TransferSlipsWorkspace } from "@/components/inventory/transfer-slips-workspace";

export const dynamic = "force-dynamic";

export default async function TransferOutPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Transfer out</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">Create outbound slips and export packing lists.</p>
      </div>
      <TransferSlipsWorkspace mode="out" />
    </div>
  );
}
