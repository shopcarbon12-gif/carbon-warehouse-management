import { Suspense } from "react";
import { CreativeHome } from "@/components/creative/home";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading Creative…</p>}>
      <CreativeHome />
    </Suspense>
  );
}
