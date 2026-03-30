import { getSession } from "@/lib/get-session";
import { InventoryCompareWorkspace } from "@/components/reports/inventory-compare-workspace";

export const dynamic = "force-dynamic";

export default async function InventoryComparePage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-[1200px] flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">POS / inventory compare</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Lightspeed expected on-hand vs WMS in-stock at the active location. Pull/Push are stubbed until LS inventory APIs are
          wired.
        </p>
      </div>
      <InventoryCompareWorkspace />
    </div>
  );
}
