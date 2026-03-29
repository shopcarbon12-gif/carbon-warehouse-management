"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRightLeft,
  LayoutDashboard,
  Map,
  Package,
  Printer,
  RefreshCw,
  Router,
  ScanLine,
  Search,
  Settings,
  X,
} from "lucide-react";
import { LocationSwitcher } from "@/components/location-switcher";
import { logoutAction } from "@/app/actions/auth";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Pulsing notification badge on the icon */
  notify?: boolean;
};

const groupsMain: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/overview/locations", label: "Locations & Bins", icon: Map },
    ],
  },
  {
    label: "RFID Workflows",
    items: [
      { href: "/rfid/cycle-counts", label: "Cycle Counts", icon: ScanLine },
      { href: "/rfid/epc-tracker", label: "EPC Tracker", icon: Search },
      { href: "/rfid/commissioning", label: "Print / Commission", icon: Printer },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/operations/exceptions",
        label: "Exceptions",
        icon: AlertTriangle,
        notify: true,
      },
      { href: "/operations/transfers", label: "Transfers", icon: ArrowRightLeft },
    ],
  },
  {
    label: "Inventory & Sync",
    items: [
      { href: "/inventory/catalog", label: "Matrix catalog", icon: Package },
      { href: "/inventory/sync", label: "Lightspeed Sync", icon: RefreshCw },
    ],
  },
];

const groupInfrastructure: { label: string; items: NavItem[] } = {
  label: "Infrastructure",
  items: [
    { href: "/infrastructure/devices", label: "Devices", icon: Router },
    { href: "/infrastructure/settings", label: "Settings", icon: Settings },
  ],
};

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === "/dashboard" && pathname === "/") return true;
  return pathname.startsWith(`${href}/`);
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

  useEffect(() => {
    onMobileOpenChange(false);
    // Stable callback from WmsShellClient (useCallback).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close drawer on route change only
  }, [pathname]);

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
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-slate-800 bg-zinc-950 shadow-2xl transition-transform duration-200 ease-out md:static md:z-0 md:translate-x-0 md:shadow-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-4">
          <Link
            href="/dashboard"
            className="min-w-0"
            onClick={() => onMobileOpenChange(false)}
          >
            <span className="font-mono text-[0.65rem] font-medium uppercase tracking-[0.2em] text-teal-400">
              WMS
            </span>
            <span className="mt-0.5 block truncate text-base font-semibold tracking-tight text-slate-100">
              Carbon WMS
            </span>
            <span className="mt-0.5 block font-mono text-[0.65rem] text-slate-500">
              RFID operations
            </span>
          </Link>
          <button
            type="button"
            aria-label="Close sidebar"
            className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100 md:hidden"
            onClick={() => onMobileOpenChange(false)}
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        <LocationSwitcher activeLocationId={activeLocationId} />

        <nav className="flex flex-1 flex-col overflow-y-auto py-2">
          {groupsMain.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-4 pb-1 pt-3 font-mono text-[0.65rem] font-medium uppercase tracking-wider text-slate-500">
                {group.label}
              </div>
              <ul className="space-y-0.5 px-2">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                          active
                            ? "bg-slate-800 text-teal-300 shadow-inner shadow-black/20 ring-1 ring-slate-700/80"
                            : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
                        }`}
                        onClick={() => onMobileOpenChange(false)}
                      >
                        <span className="relative shrink-0">
                          <Icon
                            className={`h-[1.125rem] w-[1.125rem] shrink-0 ${
                              active ? "text-teal-400" : "text-slate-400"
                            }`}
                            strokeWidth={1.75}
                            aria-hidden
                          />
                          {item.notify ? (
                            <span
                              className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-zinc-950 animate-pulse"
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
            </div>
          ))}

          <div className="mt-auto border-t border-slate-800 pt-2">
            <div className="px-4 pb-1 pt-2 font-mono text-[0.65rem] font-medium uppercase tracking-wider text-slate-500">
              {groupInfrastructure.label}
            </div>
            <ul className="space-y-0.5 px-2 pb-2">
              {groupInfrastructure.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-slate-800 text-teal-300 shadow-inner shadow-black/20 ring-1 ring-slate-700/80"
                          : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
                      }`}
                      onClick={() => onMobileOpenChange(false)}
                    >
                      <Icon
                        className={`h-[1.125rem] w-[1.125rem] shrink-0 ${
                          active ? "text-teal-400" : "text-slate-400"
                        }`}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </nav>

        <div className="border-t border-slate-800 p-4">
          <form action={logoutAction}>
            <button
              type="submit"
              className="font-mono text-xs text-teal-400/90 hover:text-teal-300 hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
