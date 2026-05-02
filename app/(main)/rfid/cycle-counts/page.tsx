import { CycleCountWorkspace } from "@/components/rfid/cycle-counts/cycle-count-workspace";
import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

export const dynamic = "force-dynamic";

export default async function CycleCountsPage() {
  const session = await getSession();
  const isAdmin = isAdminRole(session?.role ?? "");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Cycle counts</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Location or bin-scoped expected tags, simulated RFID reads, variance KPIs, and commit with
          UNKNOWN / bin corrections plus <span className="text-[var(--wms-muted)]">rfid_cycle_count</span>{" "}
          audit.
        </p>
      </div>
      <CycleCountWorkspace isAdmin={isAdmin} />
    </div>
  );
}
