import { redirect } from "next/navigation";
import { CycleCountWorkspace } from "@/components/rfid/cycle-counts/cycle-count-workspace";
import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

export const dynamic = "force-dynamic";

export default async function CycleCountsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const isAdmin = isAdminRole(session.role);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Cycle counts</h1>
        <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--wms-muted)]">
          Walk a location or bin with an RFID reader, see what&apos;s missing, what&apos;s in the
          wrong place, and what shouldn&apos;t be there at all. Pause and resume across shifts,
          export to CSV, and commit corrections with a full audit trail.
        </p>
      </div>
      <CycleCountWorkspace isAdmin={isAdmin} />
    </div>
  );
}
