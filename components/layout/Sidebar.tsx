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
  Image as ImageIcon,
  LayoutDashboard,
  Layers,
  Map,
  Package,
  PackagePlus,
  Palette,
  Pin,
  PinOff,
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
  Truck,
  Smartphone,
  Stamp,
  Tags,
  Upload,
  Users,
  UserSearch,
  Warehouse,
  Webhook,
  Star,
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
      p.startsWith("/inventory/categories") ||
      p.startsWith("/inventory/bulk-import") ||
      p.startsWith("/inventory/locations") ||
      p.startsWith("/inventory/cycle-counts") ||
      p.startsWith("/inventory/transfers"),
    items: [
      { href: "/inventory/catalog", label: "Catalog", icon: Package },
      { href: "/inventory/categories", label: "Categories", icon: Layers },
      { href: "/inventory/locations", label: "Bin Locations", icon: Map },
      { href: "/inventory/cycle-counts", label: "Cycle Counts", icon: ScanLine },
      { href: "/inventory/transfers/out", label: "Transfer Out", icon: ArrowRightLeft },
      { href: "/inventory/transfers/in", label: "Transfer In", icon: FolderInput },
      { href: "/inventory/bulk-import", label: "Bulk Import", icon: PackagePlus },
    ],
  },
  {
    id: "tags-labels",
    label: "Tags & Labels",
    isActiveSection: (p) => p.startsWith("/tags-labels"),
    items: [
      { href: "/tags-labels/print", label: "Print tags", icon: Printer },
      { href: "/tags-labels/bulk-geiger", label: "Bulk Geiger", icon: Search },
      { href: "/tags-labels/encode-items", label: "Encode Items", icon: Tags },
      { href: "/tags-labels/encode-print", label: "Encode & Print", icon: Stamp },
      { href: "/tags-labels/bulk-status", label: "Bulk status", icon: SlidersHorizontal },
      { href: "/tags-labels/ship-scan-out", label: "Ship / Scan-out", icon: Truck },
    ],
  },
  {
    id: "rfid",
    label: "RFID & Hardware",
    isActiveSection: (p) =>
      p.startsWith("/rfid/exceptions") ||
      p.startsWith("/rfid/devices") ||
      p.startsWith("/rfid/hardware-config") ||
      p.startsWith("/rfid/scan-epc") ||
      // Antenna Test page is no longer linked from the sidebar — operators
      // reach it via the per-antenna "Test" button in /rfid/hardware-config.
      // Section still highlights when an /antenna_test deep-link is open.
      p.startsWith("/antenna_test"),
    items: [
      {
        href: "/rfid/exceptions",
        label: "Exceptions",
        icon: AlertTriangle,
        notify: true,
      },
      { href: "/rfid/devices", label: "Devices", icon: Router },
      { href: "/rfid/hardware-config", label: "Hardware Config", icon: Cpu },
      { href: "/rfid/scan-epc", label: "Scan EPC", icon: ScanLine },
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
    label: "Rewards",
    isActiveSection: (p) => p.startsWith("/rewards"),
    items: [
      { href: "/rewards", label: "Overview", icon: Star },
      { href: "/rewards/customers", label: "Customers", icon: UserSearch },
      { href: "/rewards/ledger", label: "Ledger", icon: Activity },
      { href: "/rewards/tiers", label: "Tiers", icon: Layers },
      { href: "/rewards/referrals", label: "Referrals", icon: Share2 },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    isActiveSection: (p) => p.startsWith("/integrations"),
    items: [
      { href: "/integrations/sync", label: "Lightspeed Sync", icon: RefreshCw },
      { href: "/integrations/lightspeed-sales", label: "LS Sales", icon: Banknote },
      { href: "/integrations/shopify", label: "Shopify", icon: ImageIcon },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    isActiveSection: (p) => p.startsWith("/settings/"),
    items: [
      { href: "/settings/general-settings", label: "General settings", icon: Settings },
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
  pinned,
  onTogglePin,
  open,
  onOpenChange,
}: {
  activeLocationId: string;
  /** True = sidebar sits in flow + auto-stays open. False = overlay drawer
   *  that only appears when `open` is true (same as the old mobile
   *  behaviour, now available on every viewport). */
  pinned: boolean;
  onTogglePin: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pathname = usePathname() ?? "";
  // Pinned sidebars stay open after clicking a nav item — matches the
  // POS behaviour where the pin "locks" the menu. Unpinned sidebars
  // close themselves like an overlay drawer.
  const onNavigate = useCallback(() => {
    // Unconditional: harmless at md+ when pinned (aside shows via `pinned`),
    // required below md where even a pinned sidebar renders as a drawer.
    onOpenChange(false);
  }, [onOpenChange]);

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
    // Close on route change regardless of pin: at md+ a pinned sidebar is
    // shown via `pinned` (open is irrelevant), and below md the sidebar is
    // always an overlay drawer that must not cover the new page.
    onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close drawer on route change only
  }, [pathname]);

  const dashActive = useMemo(
    () => isRouteActive(pathname, "/dashboard"),
    [pathname],
  );

  // Overlay drawer (unpinned) vs in-flow (pinned). The mask covers the
  // page when the drawer is open AND the sidebar is not pinned — pinning
  // makes the sidebar a permanent column with no mask, just like the
  // pinned POS menu.
  const isOverlay = !pinned;
  const visible = pinned || open;

  // The Categories module renders its own fixed mobile top bar at z-index 260
  // (and various sheets above that). When the nav drawer opens as an overlay on
  // that route it must clear those layers, so bump the overlay/drawer z-index
  // above 260 there only — every other route keeps the original z-40 / z-50.
  const onCategories = pathname.startsWith("/inventory/categories");
  const maskZ = onCategories ? "z-[280]" : "z-40";
  const drawerZ = onCategories ? "z-[290]" : "z-50";

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className={`fixed inset-0 ${maskZ} bg-black/70 backdrop-blur-sm transition-opacity ${
          isOverlay && open
            ? "opacity-100"
            : open
              ? "pointer-events-none opacity-0 max-md:pointer-events-auto max-md:opacity-100"
              : "pointer-events-none opacity-0"
        } ${pinned ? "hidden max-md:block" : ""}`}
        onClick={() => onOpenChange(false)}
      />

      <aside
        id="wms-sidebar"
        className={`${
          isOverlay
            ? `fixed inset-y-0 left-0 ${drawerZ} shadow-2xl`
            : "static z-0 shadow-none max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl"
        } flex w-80 max-w-[85vw] shrink-0 flex-col border-r border-[var(--wms-border)] bg-[var(--wms-surface)] transition-transform duration-200 ease-out ${
          visible ? "translate-x-0" : "-translate-x-full"
        } ${pinned && !open ? "max-md:-translate-x-full" : ""}`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-4">
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
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={pinned}
              title={
                pinned
                  ? "Unpin — sidebar will close after navigation"
                  : "Pin — keep sidebar open"
              }
              onClick={onTogglePin}
              className={`rounded-md p-2 transition-colors max-md:hidden ${
                pinned
                  ? "bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] text-[var(--wms-accent)]"
                  : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              }`}
            >
              {pinned ? (
                <Pin className="h-5 w-5" strokeWidth={1.75} />
              ) : (
                <PinOff className="h-5 w-5" strokeWidth={1.75} />
              )}
            </button>
            <button
              type="button"
              aria-label="Close sidebar"
              className={`rounded-md p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)] max-md:p-2.5 ${
                pinned ? "hidden max-md:inline-flex max-md:items-center max-md:justify-center" : ""
              }`}
              onClick={() => onOpenChange(false)}
            >
              <X className="h-5 w-5" strokeWidth={1.75} />
            </button>
          </div>
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
              className="font-mono text-base text-[var(--wms-accent)] hover:underline max-md:-m-2 max-md:inline-block max-md:p-2"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
