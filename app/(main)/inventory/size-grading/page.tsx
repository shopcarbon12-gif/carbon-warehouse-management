import { getSession } from "@/lib/get-session";
import { GradingHub } from "@/components/size-grading/grading-hub";

export const dynamic = "force-dynamic";

export default async function SizeGradingPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6 max-md:w-full">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="flex items-center gap-3.5 text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          {/* The CarbonGradingAI app icon (owner-approved 2026-10-22). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/size-grading/carbongradingai-icon.webp" alt="" width={64} height={64} className="h-16 w-16 rounded-[1rem]" />
          Size Grading
        </h1>
      </div>
      <GradingHub />
    </div>
  );
}
