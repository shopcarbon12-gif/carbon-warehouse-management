"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/tags-labels/print/rfid", label: "RFID tags" },
  { href: "/tags-labels/print/non-rfid", label: "Non-RFID tags" },
];

/** Segmented pill tabs, each sized to fill the container (flex-1). */
export function PrintTagsTabs() {
  const pathname = usePathname() ?? "";
  const isNon = pathname.includes("/non-rfid");
  return (
    <div className="flex gap-2.5">
      {TABS.map((t) => {
        const active = t.href.includes("/non-rfid") ? isNon : !isNon;
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={`inline-flex flex-1 items-center justify-center gap-2.5 rounded-xl border px-5 py-3 font-mono text-sm font-bold tracking-wide transition ${
              active
                ? "border-[var(--wms-accent)] bg-[color-mix(in_srgb,var(--wms-accent)_15%,transparent)] text-[var(--wms-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--wms-accent)_30%,transparent),0_0_18px_color-mix(in_srgb,var(--wms-accent)_18%,transparent)]"
                : "border-[var(--wms-border)] text-[var(--wms-muted)] hover:border-[var(--wms-accent)]/45 hover:text-[var(--wms-fg)]"
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-current opacity-90" aria-hidden />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
