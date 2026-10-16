"use client";

import { useUrlParam } from "@/lib/use-url-param";
import { LocationsManager } from "./locations-manager";
import { ShelfMap } from "./shelf-map";
import { ZonesManager } from "./zones-manager";

type Tab = "list" | "map" | "zones";

/** Tab strip wrapping the existing List view + the new Shelf Map view.
 *  The active tab lives in the URL (?tab=map; List is the default) so a
 *  browser refresh — and a restored ?bin= drawer — lands on the same view. */
export function LocationsTabs({ canCleanBins }: { canCleanBins: boolean }) {
  const [tabParam, setTabParam] = useUrlParam("tab");
  const tab: Tab = tabParam === "map" ? "map" : tabParam === "zones" ? "zones" : "list";
  const setTab = (t: Tab) => setTabParam(t === "list" ? null : t);

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-[var(--wms-border)]">
        <TabButton id="list" active={tab === "list"} onClick={() => setTab("list")}>
          List
        </TabButton>
        <TabButton id="map" active={tab === "map"} onClick={() => setTab("map")}>
          Shelf Map
        </TabButton>
        <TabButton id="zones" active={tab === "zones"} onClick={() => setTab("zones")}>
          Zones
        </TabButton>
      </div>

      {tab === "list" ? (
        <LocationsManager canCleanBins={canCleanBins} />
      ) : tab === "map" ? (
        <ShelfMap canManage={canCleanBins} />
      ) : (
        <ZonesManager />
      )}
    </div>
  );
}

function TabButton({
  id,
  active,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-2 font-mono text-sm transition-colors ${
        active
          ? "border-b-2 border-[var(--wms-accent)] text-[var(--wms-fg)]"
          : "border-b-2 border-transparent text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
      }`}
    >
      {children}
    </button>
  );
}
