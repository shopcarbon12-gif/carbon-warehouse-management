export const dynamic = "force-dynamic";

import { getSession } from "@/lib/get-session";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { LocationsTabs } from "@/components/overview/locations/locations-tabs";

export default async function OverviewLocationsPage() {
  const session = await getSession();
  const canCleanBins = session ? isAdminRole(session.role ?? "") : false;

  return (
    <div className="mx-auto flex min-w-0 max-w-[1500px] flex-col gap-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Bin Locations
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          <strong>List</strong>: classic dual-pane bin manager. <strong>Shelf Map</strong>: physical
          5×3 rack view per (aisle, section) — move colors between bins with one click.
        </p>
      </div>
      <LocationsTabs canCleanBins={canCleanBins} />
    </div>
  );
}
