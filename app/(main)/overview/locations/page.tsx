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
          Bin Locations
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Dual-pane map: pick a location, manage bins on the right. Search by typing the bin
          (number then letter, e.g. <span className="text-[var(--wms-fg)]">5A01</span> shows
          5A01L / 5A01C / 5A01R). Delete unassigns any items first, then removes the bin.
        </p>
      </div>
      <LocationsManager canCleanBins={canCleanBins} />
    </div>
  );
}
