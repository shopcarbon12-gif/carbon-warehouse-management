import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { getPool } from "@/lib/db";
import { listTenantLocationsWithBins } from "@/lib/server/overview-locations";
import { LocationsManager } from "@/components/overview/locations/locations-manager";

export default async function OverviewLocationsPage() {
  const session = await getSession();
  const canCleanBins = session ? isAdminRole(session.role ?? "") : false;

  let initialLocations: Awaited<ReturnType<typeof listTenantLocationsWithBins>> = [];
  if (session) {
    const pool = getPool();
    if (pool) {
      try {
        initialLocations = await listTenantLocationsWithBins(pool, session.tid);
      } catch {
        initialLocations = [];
      }
    }
  }

  return (
    <div className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">
          Locations &amp; bins
        </h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Dual-pane map: pick a location, manage bins on the right. Archive is blocked while
          in-stock EPCs reference a bin. Switch the active site from the sidebar for RFID ops.
        </p>
      </div>
      <LocationsManager canCleanBins={canCleanBins} initialLocations={initialLocations} />
    </div>
  );
}
