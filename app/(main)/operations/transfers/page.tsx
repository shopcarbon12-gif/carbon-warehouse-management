import { TransferWorkspace } from "@/components/operations/transfers/transfer-workspace";

export const dynamic = "force-dynamic";

export default function TransfersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Transfers</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Stage RFID-tagged inventory, move to a destination bin, and commit. Audits record{" "}
          <span className="text-orange-400/80">source_location</span>,{" "}
          <span className="text-orange-400/80">destination_location</span>, and full{" "}
          <span className="text-orange-400/80">epcs[]</span> for the EPC tracker.
        </p>
      </div>
      <TransferWorkspace />
    </div>
  );
}
