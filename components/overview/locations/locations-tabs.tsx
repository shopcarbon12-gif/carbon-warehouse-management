"use client";

import { useUrlParam } from "@/lib/use-url-param";
import { LocationsManager } from "./locations-manager";
import { ShelfMap } from "./shelf-map";

type Tab = "list" | "map";

/** Tab strip wrapping the existing List view + the new Shelf Map view.
 *  The active tab lives in the URL (?tab=map; List is the default) so a
 *  browser refresh — and a restored ?bin= drawer — lands on the same view. */
export function LocationsTabs({ canCleanBins }: { canCleanBins: boolean }) {
  const [tabParam, setTabParam] = useUrlParam("tab");
  const tab: Tab = tabParam === "map" ? "map" : "list";
  const setTab = (t: Tab) => setTabParam(t === "map" ? "map" : null);

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-[var(--wms-border)]">
        <TabButton id="list" active={tab === "list"} onClick={() => setTab("list")}>
          List
        </TabButton>
        <TabButton id="map" active={tab === "map"} onClick={() => setTab("map")}>
          Shelf Map
        </TabButton>
      </div>

      {tab === "list" ? (
        <LocationsManager canCleanBins={canCleanBins} />
      ) : (
        <ShelfMap canManage={canCleanBins} />
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
