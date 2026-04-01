import { CommissioningWorkspace } from "@/components/rfid/commissioning/commissioning-workspace";

export const dynamic = "force-dynamic";

export default function CommissioningPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">
          Print / commission
        </h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Studio-style RFID commissioning: broad catalog lookup, 812×594 label preview, printer
          defaults, staged task status, optional in-stock placement, and audit-backed print
          history.
        </p>
      </div>
      <CommissioningWorkspace />
    </div>
  );
}
