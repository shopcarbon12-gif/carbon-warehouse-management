import { Suspense } from "react";
import { WholesaleWorkspace } from "@/components/shopify/wholesale-workspace";

export const dynamic = "force-dynamic";

export default function WholesalePage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <Suspense fallback={<p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading wholesale applications…</p>}>
        <WholesaleWorkspace />
      </Suspense>
    </div>
  );
}
