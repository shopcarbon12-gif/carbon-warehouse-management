import { CycleCountWorkspace } from "@/components/rfid/cycle-counts/cycle-count-workspace";

export const dynamic = "force-dynamic";

export default function CycleCountsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Cycle counts</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-slate-500">
          Location or bin-scoped expected tags, simulated RFID reads, variance KPIs, and commit with
          UNKNOWN / bin corrections plus <span className="text-slate-400">rfid_cycle_count</span>{" "}
          audit.
        </p>
      </div>
      <CycleCountWorkspace />
    </div>
  );
}
