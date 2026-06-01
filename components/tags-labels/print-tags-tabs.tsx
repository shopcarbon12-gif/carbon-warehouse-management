"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/tags-labels/print/rfid", label: "RFID tags" },
  { href: "/tags-labels/print/non-rfid", label: "Non-RFID tags" },
];

/** Text tabs matching the WMS house style (e.g. Bin Locations List/Shelf Map). */
export function PrintTagsTabs() {
  const pathname = usePathname() ?? "";
  const isNon = pathname.includes("/non-rfid");
  return (
    <div role="tablist" className="flex gap-1 border-b border-[var(--wms-border)]">
      {TABS.map((t) => {
        const active = t.href.includes("/non-rfid") ? isNon : !isNon;
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={`px-4 py-2 font-mono text-sm transition-colors ${
              active
                ? "border-b-2 border-[var(--wms-accent)] text-[var(--wms-fg)]"
                : "border-b-2 border-transparent text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
