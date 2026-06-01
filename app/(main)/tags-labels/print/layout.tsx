import type { ReactNode } from "react";
import { PrintTagsTabs } from "@/components/tags-labels/print-tags-tabs";

/** Shared chrome for the Print Tags tabs — centered container like other WMS pages. */
export default function PrintTagsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Print tags</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Commission RFID hang-tags or print non-RFID labels: find the product, set quantity and
          placement, preview the tag exactly as it prints, then print in one pass.
        </p>
      </div>
      <PrintTagsTabs />
      {children}
    </div>
  );
}
