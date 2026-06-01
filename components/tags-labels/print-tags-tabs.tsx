"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/tags-labels/print/rfid", label: "RFID tags" },
  { href: "/tags-labels/print/non-rfid", label: "Non-RFID tags" },
];

/** Segmented tab bar — each tab is its own route/URL; RFID is the default. */
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
            aria-current={active ? "page" : undefined}
            className={`inline-flex flex-1 items-center justify-center gap-2.5 whitespace-nowrap rounded-xl border px-6 py-3.5 font-mono text-base font-bold tracking-wide transition sm:flex-none ${
              active
                ? "border-[var(--wms-accent)] bg-[color-mix(in_srgb,var(--wms-accent)_15%,transparent)] text-[var(--wms-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--wms-accent)_35%,transparent),0_0_22px_color-mix(in_srgb,var(--wms-accent)_22%,transparent)]"
                : "border-[var(--wms-border)] text-[var(--wms-muted)] hover:border-[var(--wms-accent)]/45 hover:text-[var(--wms-fg)]"
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-full bg-current opacity-90" aria-hidden />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
