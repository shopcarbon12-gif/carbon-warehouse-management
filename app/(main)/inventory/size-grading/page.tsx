import { getSession } from "@/lib/get-session";
import { SizeGradingWorkspace } from "@/components/size-grading/size-grading-workspace";

export const dynamic = "force-dynamic";

export default async function SizeGradingPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Size Grading</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Photograph a T-shirt laid flat. The page measures chest width, body length and hem width, then grades it
          against the size chart. Prototype — everything runs on this device; nothing is saved to inventory.
        </p>
      </div>
      <SizeGradingWorkspace />
    </div>
  );
}
