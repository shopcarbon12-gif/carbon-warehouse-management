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
  ClipboardList,
  Cpu,
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
  UserSearch,
  Warehouse,
  Webhook,
  Star,
  Gift,
  Share2,
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
      p.startsWith("/inventory/bulk-status") ||
      p.startsWith("/overview/locations") ||
      p.startsWith("/rfid/cycle-counts") ||
      p.startsWith("/operations/transfers"),
    items: [
      { href: "/inventory/catalog", label: "Catalog", icon: Package },
      { href: "/overview/locations", label: "Locations & Bins", icon: Map },
      { href: "/rfid/cycle-counts", label: "Cycle Counts", icon: ScanLine },
      { href: "/operations/transfers/out", label: "Transfer Out", icon: ArrowRightLeft },
      { href: "/operations/transfers/in", label: "Transfer In", icon: FolderInput },
      { href: "/inventory/bulk-status", label: "Bulk status", icon: SlidersHorizontal },
    ],
  },
  {
    id: "rfid",
    label: "RFID & Hardware",
    isActiveSection: (p) =>
      p.startsWith("/rfid/epc-tracker") ||
      p.startsWith("/rfid/commissioning") ||
      p.startsWith("/operations/exceptions") ||
      p.startsWith("/infrastructure/devices") ||
      p.startsWith("/hardware_config") ||
      p.startsWith("/antenna_test"),
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
      { href: "/hardware_config", label: "Hardware Config", icon: Cpu },
      { href: "/antenna_test", label: "Antenna Test", icon: Radio },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    isActiveSection: (p) => p.startsWith("/reports/"),
    items: [
      { href: "/reports/inventory-compare", label: "POS compare", icon: Banknote },
      { href: "/reports/count-sessions", label: "Count sessions", icon: ClipboardList },
      { href: "/reports/transfers/out", label: "Transfer out (report)", icon: ArrowRightLeft },
      { href: "/reports/transfers/in", label: "Transfer in (report)", icon: FolderInput },
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
    id: "loyalty",
    label: "Loyalty",
    isActiveSection: (p) => p.startsWith("/loyalty"),
    items: [
      { href: "/loyalty", label: "Overview", icon: Star },
      { href: "/loyalty/customers", label: "Members", icon: UserSearch },
      { href: "/loyalty/ledger", label: "Ledger", icon: Activity },
      { href: "/loyalty/tiers", label: "Tiers", icon: Layers },
      { href: "/loyalty/referrals", label: "Referrals", icon: Share2 },
      { href: "/loyalty/rewards", label: "Rewards", icon: Gift },
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

  // Click handler for nav items: if the operator clicks the menu entry
  // for the page they're already on, Next's <Link> normally no-ops.
  // The operator expects clicking a nav item to *always* do something —
  // either move there, or fully reload the current page. We use
  // `window.location.reload()` (not `router.refresh()`) because RSC
  // refresh leaves client state mounted, so on client-heavy pages
  // (Antenna Test, Hardware Config workspace) the reload looks like a
  // no-op. A real reload tears down React state and reruns the page.
  const handleNavClick = useCallback(
    (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      onNavigate();
      if (href === pathname) {
        e.preventDefault();
        window.location.reload();
      }
    },
    [pathname, onNavigate],
  );

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
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-3 text-left font-mono text-base font-semibold uppercase tracking-wide text-[var(--wms-secondary)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
        onClick={() => setOpen((o) => !o)}
      >
        {section.label}
        <ChevronDown
          className={`h-6 w-6 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
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
                  className={`flex items-center gap-3 rounded-lg px-3 py-3 text-lg font-medium leading-snug transition-colors ${
                    active
                      ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)] ring-1 ring-[var(--wms-border)]"
                      : "text-[var(--wms-fg)]/85 hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                  }`}
                  onClick={handleNavClick(item.href)}
                >
                  <span className="relative shrink-0">
                    <Icon
                      className={`h-6 w-6 shrink-0 ${
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

  // Same-route refresh: clicking a menu entry for the page you're
  // already on should fully reload it (window.location.reload), not a
  // soft RSC refresh — RSC leaves client state mounted, so client-heavy
  // pages look like the click did nothing. Mirrors NavAccordion's
  // handleNavClick on the top-level Dashboard / brand links.
  const handleSameRouteRefresh = useCallback(
    (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      onNavigate();
      if (href === pathname) {
        e.preventDefault();
        window.location.reload();
      }
    },
    [pathname, onNavigate],
  );

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
        className={`fixed inset-y-0 left-0 z-50 flex w-80 shrink-0 flex-col border-r border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl transition-transform duration-200 ease-out md:static md:z-0 md:translate-x-0 md:shadow-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-4">
          <Link
            href="/dashboard"
            className="min-w-0"
            onClick={handleSameRouteRefresh("/dashboard")}
          >
            <span className="font-mono text-sm font-medium uppercase tracking-[0.18em] text-[var(--wms-accent)]">
              WMS
            </span>
            <span className="mt-0.5 block truncate text-xl font-semibold tracking-tight text-[var(--wms-fg)]">
              CarbonWMS
            </span>
            <span className="mt-0.5 block font-mono text-base text-[var(--wms-muted)]">
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
              onClick={handleSameRouteRefresh("/dashboard")}
              className={`flex items-center gap-3 rounded-lg px-3 py-3 text-lg font-medium leading-snug transition-colors ${
                dashActive
                  ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)] ring-1 ring-[var(--wms-border)]"
                  : "text-[var(--wms-fg)]/85 hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              }`}
            >
              <LayoutDashboard
                className={`h-6 w-6 ${dashActive ? "text-[var(--wms-accent)]" : "text-[var(--wms-muted)]"}`}
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
              className="font-mono text-base text-[var(--wms-accent)] hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
