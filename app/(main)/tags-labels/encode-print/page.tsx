import { EncodePrintWorkspace } from "@/components/rfid/encode-print/encode-print-workspace";

export const dynamic = "force-dynamic";

export default function EncodePrintPage() {
  return (
    <div className="space-y-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Encode &amp; Print</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Scan a tag on .70 → encode it to a SKU → re-read to confirm the chip took the write → print the
          matching non-RFID label. One tag at a time, with the .70 proximity slider.
        </p>
      </div>
      <EncodePrintWorkspace />
    </div>
  );
}
