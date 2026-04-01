"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Banknote,
  ChevronDown,
  Download,
  FolderInput,
  LayoutDashboard,
  Layers,
  Map,
  Package,
  PackagePlus,
  Palette,
  Printer,
  Radio,
  RefreshCw,
  Route,
  Router,
  ScanLine,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Tags,
  Upload,
  Users,
  Warehouse,
  Webhook,
  X,
} from "lucide-react";
import { LocationSwitcher } from "@/components/location-switcher";
import { logoutAction } from "@/app/actions/auth";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  notify?: boolean;
};

type NavSection = {
  id: string;
  label: string;
  /** Return true if pathname belongs in this drawer (keeps it open). */
  isActiveSection: (pathname: string) => boolean;
  items: NavItem[];
};

const sections: NavSection[] = [
  {
    id: "inventory",
    label: "Inventory",
    isActiveSection: (p) =>
      p.startsWith("/inventory/catalog") ||
      p.startsWith("/inventory/transfers") ||
      p.startsWith("/inventory/bulk-status") ||
      p.startsWith("/overview/locations") ||
      p.startsWith("/rfid/cycle-counts") ||
      p.startsWith("/operations/transfers"),
    items: [
      { href: "/inventory/catalog", label: "Catalog", icon: Package },
      { href: "/overview/locations", label: "Locations & Bins", icon: Map },
      { href: "/rfid/cycle-counts", label: "Cycle Counts", icon: ScanLine },
      { href: "/inventory/transfers/out", label: "Transfer out", icon: ArrowRightLeft },
      { href: "/inventory/transfers/in", label: "Transfer in", icon: FolderInput },
      { href: "/inventory/bulk-status", label: "Bulk status", icon: SlidersHorizontal },
      { href: "/operations/transfers", label: "Transfers (legacy)", icon: Route },
    ],
  },
  {
    id: "rfid",
    label: "RFID & Hardware",
    isActiveSection: (p) =>
      p.startsWith("/rfid/epc-tracker") ||
      p.startsWith("/rfid/commissioning") ||
      p.startsWith("/operations/exceptions") ||
      p.startsWith("/infrastructure/devices"),
    items: [
      { href: "/rfid/epc-tracker", label: "EPC Tracker", icon: Search },
      { href: "/rfid/commissioning", label: "Print / Commission", icon: Printer },
      {
        href: "/operations/exceptions",
        label: "Exceptions",
        icon: AlertTriangle,
        notify: true,
      },
      { href: "/infrastructure/devices", label: "Devices", icon: Router },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    isActiveSection: (p) => p.startsWith("/reports/"),
    items: [
      { href: "/reports/inventory-compare", label: "POS compare", icon: Banknote },
      { href: "/reports/uploads", label: "Device upload logs", icon: Upload },
      { href: "/reports/activity", label: "Activity history", icon: Activity },
      { href: "/reports/asset-movements", label: "Asset movements", icon: Route },
      { href: "/reports/status-logs", label: "Status & tag logs", icon: Tags },
      { href: "/reports/adjustments", label: "Inventory adjustments", icon: SlidersHorizontal },
      { href: "/reports/replenishments", label: "Replenishments", icon: PackagePlus },
      { href: "/reports/bulk-imports", label: "Bulk imports", icon: FolderInput },
      { href: "/reports/external-systems", label: "External systems", icon: Webhook },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    isActiveSection: (p) =>
      p.startsWith("/inventory/sync") || p.startsWith("/infrastructure/lightspeed-sales"),
    items: [
      { href: "/inventory/sync", label: "Lightspeed Sync", icon: RefreshCw },
      { href: "/infrastructure/lightspeed-sales", label: "LS Sales", icon: Banknote },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    isActiveSection: (p) => p.startsWith("/settings/") || p.startsWith("/infrastructure/settings"),
    items: [
      { href: "/infrastructure/settings", label: "General settings", icon: Settings },
      { href: "/settings/theme", label: "Theme & style", icon: Palette },
      { href: "/settings/handheld", label: "Handheld settings", icon: Smartphone },
      { href: "/settings/updates", label: "Mobile OTA", icon: Download },
      { href: "/settings/devices", label: "Device binding", icon: Shield },
      { href: "/settings/statuses", label: "Status labels", icon: Tags },
      { href: "/settings/general", label: "RFID EPC (general)", icon: Radio },
      { href: "/settings/epc-profiles", label: "EPC profiles", icon: Layers },
      { href: "/settings/users", label: "Users & roles", icon: Users },
      { href: "/settings/locations", label: "Locations", icon: Warehouse },
    ],
  },
];

function isRouteActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === "/dashboard" && pathname === "/") return true;
  return pathname.startsWith(`${href}/`);
}

function NavAccordion({
  section,
  pathname,
  onNavigate,
}: {
  section: NavSection;
  pathname: string;
  onNavigate: () => void;
}) {
  const activeInSection = section.isActiveSection(pathname);
  const [open, setOpen] = useState(activeInSection);

  /* Expand drawer when route enters this section (nav UX). */
  useEffect(() => {
    if (!activeInSection) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync accordion open state with active route
    setOpen(true);
  }, [activeInSection]);

  return (
    <div className="mb-1 border-b border-[var(--wms-border)]/60 pb-1 last:border-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[var(--wms-secondary)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
        onClick={() => setOpen((o) => !o)}
      >
        {section.label}
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      {open ? (
        <ul className="mt-0.5 space-y-0.5 px-1">
          {section.items.map((item) => {
            const active = isRouteActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)] ring-1 ring-[var(--wms-border)]"
                      : "text-[var(--wms-fg)]/85 hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                  }`}
                  onClick={onNavigate}
                >
                  <span className="relative shrink-0">
                    <Icon
                      className={`h-[1.125rem] w-[1.125rem] shrink-0 ${
                        active ? "text-[var(--wms-accent)]" : "text-[var(--wms-muted)]"
                      }`}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    {item.notify ? (
                      <span
                        className="absolute -right-1 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-red-500 ring-2 ring-[var(--wms-surface)]"
                        aria-hidden
                      />
                    ) : null}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function Sidebar({
  activeLocationId,
  mobileOpen,
  onMobileOpenChange,
}: {
  activeLocationId: string;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}) {
  const pathname = usePathname() ?? "";
  const onNavigate = useCallback(() => {
    onMobileOpenChange(false);
  }, [onMobileOpenChange]);

  useEffect(() => {
    onMobileOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close drawer on route change only
  }, [pathname]);

  const dashActive = useMemo(
    () => isRouteActive(pathname, "/dashboard"),
    [pathname],
  );

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className={`fixed inset-0 z-40 bg-black/70 backdrop-blur-sm transition-opacity md:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => onMobileOpenChange(false)}
      />

      <aside
        id="wms-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl transition-transform duration-200 ease-out md:static md:z-0 md:translate-x-0 md:shadow-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-4">
          <Link href="/dashboard" className="min-w-0" onClick={onNavigate}>
            <span className="font-mono text-[0.65rem] font-medium uppercase tracking-[0.2em] text-[var(--wms-accent)]">
              WMS
            </span>
            <span className="mt-0.5 block truncate text-base font-semibold tracking-tight text-[var(--wms-fg)]">
              CarbonWMS
            </span>
            <span className="mt-0.5 block font-mono text-[0.65rem] text-[var(--wms-muted)]">
              RFID operations
            </span>
          </Link>
          <button
            type="button"
            aria-label="Close sidebar"
            className="rounded-md p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)] md:hidden"
            onClick={() => onMobileOpenChange(false)}
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        <LocationSwitcher activeLocationId={activeLocationId} />

        <nav className="flex flex-1 flex-col overflow-y-auto py-2">
          <div className="px-2 pb-2">
            <Link
              href="/dashboard"
              onClick={onNavigate}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                dashActive
                  ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)] ring-1 ring-[var(--wms-border)]"
                  : "text-[var(--wms-fg)]/85 hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              }`}
            >
              <LayoutDashboard
                className={`h-[1.125rem] w-[1.125rem] ${dashActive ? "text-[var(--wms-accent)]" : "text-[var(--wms-muted)]"}`}
                strokeWidth={1.75}
                aria-hidden
              />
              Dashboard
            </Link>
          </div>

          <div className="px-2">
            {sections.map((section) => (
              <NavAccordion
                key={section.id}
                section={section}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </nav>

        <div className="border-t border-[var(--wms-border)] p-4">
          <form action={logoutAction}>
            <button
              type="submit"
              className="font-mono text-xs text-[var(--wms-accent)] hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
