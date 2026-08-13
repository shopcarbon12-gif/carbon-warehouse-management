import { ShipScanOutWorkspace } from "@/components/rfid/ship-scan-out/ship-scan-out-workspace";

export const dynamic = "force-dynamic";

export default function ShipScanOutPage() {
  return (
    <div className="space-y-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Ship / Scan-out</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          When you ship an online order, scan the item&apos;s tag here → it flips to{" "}
          <span className="text-[var(--wms-fg)]">sold</span>. The EPC value is never changed. An online sale
          tentatively marks the oldest tag <span className="text-[var(--wms-fg)]">unknown</span>; the daily
          cycle count flips any still-present unknown tag back to in-stock.
        </p>
      </div>
      <ShipScanOutWorkspace />
    </div>
  );
}
