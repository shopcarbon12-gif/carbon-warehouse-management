import { EpcTrackerWorkspace } from "@/components/rfid/epc-tracker/epc-tracker-workspace";

export const dynamic = "force-dynamic";

export default function EpcTrackerPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">EPC tracker</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Search by 24-char hex EPC, SKU, or Lightspeed System ID; inspect tag status, decoded
          96-bit layout, and audit timeline (
          <span className="text-blue-400/80">print</span>,{" "}
          <span className="text-emerald-400/80">receive</span>,{" "}
          <span className="text-[var(--wms-muted)]">cycle count</span>,{" "}
          <span className="text-orange-400/80">transfer</span>,{" "}
          <span className="text-red-400/80">exception / alarm</span>).
        </p>
      </div>
      <EpcTrackerWorkspace />
    </div>
  );
}
