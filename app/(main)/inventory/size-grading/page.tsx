import Link from "next/link";
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
          Photograph a garment laid flat beside the printed target. The target fixes the scale and squares the photo
          up, so the camera can be hand-held at any distance or angle; the garment is then measured and saved against
          the item. Front and back are measured separately.
        </p>
        <nav className="mt-2 flex flex-wrap gap-2" aria-label="CarbonGradingAI">
          {[
            { href: "/inventory/size-grading/cut-groups", label: "Cut groups" },
            { href: "/inventory/size-grading/review", label: "Scan review" },
          ].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-md border border-[var(--wms-border)] px-2.5 py-1 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] max-md:inline-flex max-md:min-h-11 max-md:items-center"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <SizeGradingWorkspace />
    </div>
  );
}
