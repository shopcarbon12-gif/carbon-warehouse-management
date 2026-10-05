import { ShipScanOutWorkspace } from "@/components/rfid/ship-scan-out/ship-scan-out-workspace";

export const dynamic = "force-dynamic";

export default function ScanOutPage() {
  return (
    <div className="space-y-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Scan-out</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Hold the items going to a customer at the .87 antenna, check them, and scan them out — their tags become{" "}
          <span className="text-[var(--wms-fg)]">SOLD</span>. An online order marks one LIVE tag of each item it sold{" "}
          <span className="text-[var(--wms-fg)]">UNKNOWN</span> until it ships; either can be scanned out.
        </p>
      </div>
      <ShipScanOutWorkspace />
    </div>
  );
}
