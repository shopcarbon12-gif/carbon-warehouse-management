export const dynamic = "force-dynamic";

import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { LocationsManager } from "@/components/overview/locations/locations-manager";

export default async function OverviewLocationsPage() {
  const session = await getSession();
  const canCleanBins = session ? isAdminRole(session.role ?? "") : false;

  return (
    <div className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Locations &amp; bins
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Dual-pane map: pick a location, manage bins on the right. Archive is blocked while
          in-stock EPCs reference a bin. Switch the active site from the sidebar for RFID ops.
        </p>
      </div>
      <LocationsManager canCleanBins={canCleanBins} />
    </div>
  );
}
