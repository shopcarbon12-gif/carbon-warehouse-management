"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  LayoutDashboard,
  Menu,
  PackageCheck,
  Boxes,
} from "lucide-react";

/**
 * Phone-only bottom tab bar (md:hidden — desktop never renders it).
 * Thumb-zone shortcuts to the four most-walked operator routes plus a
 * Menu tab that opens the nav drawer. Mirrors the sidebar's same-route
 * contract: tapping the tab for the page you're on full-reloads it
 * (plain <Link> would soft no-op via RSC).
 *
 * Not rendered on /inventory/categories — that route owns its own fixed
 * bottom commit dock (z-200) and the shell force-collapses there.
 */
const TABS: { href: string; label: string; icon: typeof LayoutDashboard }[] = [
  { href: "/dashboard", label: "Dash", icon: LayoutDashboard },
  { href: "/inventory/catalog", label: "Catalog", icon: Boxes },
  { href: "/inventory/cycle-counts", label: "Counts", icon: ClipboardList },
  { href: "/tags-labels/ship-scan-out", label: "Ship", icon: PackageCheck },
];

export function MobileTabBar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-[var(--wms-border)] bg-[var(--wms-surface)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            onClick={(e) => {
              if (pathname === t.href) {
                e.preventDefault();
                window.location.reload();
              }
            }}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 font-mono text-[0.6rem] uppercase tracking-wide ${
              active
                ? "text-[var(--wms-accent)]"
                : "text-[var(--wms-muted)] active:bg-[var(--wms-surface-elevated)]"
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} aria-hidden />
            <span>{t.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation menu"
        className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] active:bg-[var(--wms-surface-elevated)]"
      >
        <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        <span>Menu</span>
      </button>
    </nav>
  );
}
