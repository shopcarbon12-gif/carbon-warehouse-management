import { Store } from "lucide-react";

/** The Zone Management zone the catalog flags with a store icon (name match, any case). */
export function isStoreZone(zoneName: string | null | undefined): boolean {
  return zoneName?.trim().toLowerCase() === "store";
}

/** Store icon shown in the catalog Channels column and next to a tag's status. */
export function StoreZoneIcon({ title, className = "h-5 w-5" }: { title: string; className?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center text-[var(--wms-accent)]" title={title} aria-label={title} role="img">
      <Store className={className} strokeWidth={2} />
    </span>
  );
}
