import { getSession } from "@/lib/get-session";
import { GradingHub } from "@/components/size-grading/grading-hub";

export const dynamic = "force-dynamic";

export default async function SizeGradingPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6 max-md:w-full">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Size Grading</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Garments are measured with the CarbonGradingAI app on the depth-camera Samsungs. Every scan it saves lands
          here: check the flagged ones, see what is left to measure, and look up any item&apos;s measurements.
        </p>
      </div>
      <GradingHub />
    </div>
  );
}
