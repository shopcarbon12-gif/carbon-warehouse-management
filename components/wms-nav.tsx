"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const groups: { label: string; items: { href: string; label: string }[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/locations", label: "Locations" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/inventory", label: "Inventory" },
      { href: "/alerts", label: "Alerts & exceptions" },
      { href: "/compare", label: "RFID ↔ POS compare" },
      { href: "/rfid", label: "RFID workflows" },
    ],
  },
  {
    label: "Channels",
    items: [
      { href: "/integrations", label: "Integrations" },
      { href: "/sync", label: "Sync & reconciliation" },
    ],
  },
  {
    label: "Field",
    items: [{ href: "/handheld", label: "Handheld" }],
  },
  {
    label: "Admin",
    items: [
      { href: "/orders", label: "Orders" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

export function WmsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-0 py-2">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-4 pb-1 pt-3 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--muted)]">
            {g.label}
          </div>
          {g.items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block border-l-[3px] px-4 py-2 text-sm transition-colors ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--foreground)]"
                    : "border-transparent text-[var(--foreground)] hover:bg-[var(--surface-border)]/40"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
