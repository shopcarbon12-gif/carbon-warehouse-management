import { Suspense } from "react";
import { CreativeLibrary } from "@/components/creative/library";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading Creative…</p>}>
      <CreativeLibrary />
    </Suspense>
  );
}
