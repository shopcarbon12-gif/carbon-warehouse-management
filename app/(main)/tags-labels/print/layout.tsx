import type { ReactNode } from "react";
import { PrintTagsTabs } from "@/components/tags-labels/print-tags-tabs";

/** Shared chrome for the Print Tags tabs (RFID / Non-RFID). */
export default function PrintTagsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--wms-fg)]">Print tags</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Commission RFID hang-tags or print non-RFID labels: find the product, set quantity and
          placement, preview the tag exactly as it prints, then print in one pass.
        </p>
      </div>
      <PrintTagsTabs />
      {children}
    </div>
  );
}
