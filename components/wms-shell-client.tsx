"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { SyncProgressFloater } from "@/components/inventory/sync/sync-progress-floater";
import { AlertSoundListener } from "@/components/wms-alerts";

/** localStorage key for the pin state (sidebar stays open across navigation). */
const PIN_KEY = "wms.sidebar.pinned";

/**
 * Human title for the phone header (the md+ header keeps the brand).
 * Derived from the last meaningful path segment; id-looking segments
 * (uuids, numbers) fall back to their parent segment.
 */
function pageTitle(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return "CarbonWMS";
  let last = segs[segs.length - 1];
  if (/^(\d+|[0-9a-f]{8}[0-9a-f-]*)$/i.test(last) && segs.length > 1) {
    last = segs[segs.length - 2];
  }
  const words = last.replace(/[-_]+/g, " ").trim();
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : "CarbonWMS";
}

export function WmsShellClient({
  activeLocationId,
  banner,
  embedded = false,
  children,
}: {
  activeLocationId: string;
  banner?: React.ReactNode;
  embedded?: boolean;
  children: React.ReactNode;
}) {
  // Pin = "keep sidebar open like the POS menu pin." Persists across
  // page loads via localStorage. Defaults to true on first visit so
  // existing operators don't suddenly lose their menu after this ships.
  // useState initializer runs on the server with undefined → null; we
  // sync from localStorage in an effect to avoid hydration mismatch.
  const [pinned, setPinned] = useState<boolean>(true);
  const [open, setOpen] = useState(false);

  // The Categories page hosts a full-width windowed manager popup, so the
  // sidebar must auto-collapse to the side on that route only — regardless of
  // the operator's pin preference. We override the *effective* pin here (the
  // stored `pinned` value is left untouched, so every other page keeps its
  // normal behaviour and the preference is restored on navigate-away).
  const pathname = usePathname() ?? "";
  const forceCollapsed = pathname.startsWith("/inventory/categories");
  const effectivePinned = forceCollapsed ? false : pinned;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- collapse the drawer when entering the Categories route
    if (forceCollapsed) setOpen(false);
  }, [forceCollapsed]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PIN_KEY);
      if (raw === "0") setPinned(false);
      else if (raw === "1") setPinned(true);
    } catch {
      /* SSR or storage blocked — keep default */
    }
  }, []);

  const togglePin = useCallback(() => {
    setPinned((p) => {
      const next = !p;
      try {
        window.localStorage.setItem(PIN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      // When pinning, snap closed → open. When unpinning, leave the
      // open state alone so the operator sees their last gesture.
      if (next) setOpen(true);
      return next;
    });
  }, []);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  /* Inside the CarbonGradingAI app (its WebView says so in the user agent):
     only the page, in the light theme — the app has its own bars (owner, 2026-10-22). */
  if (embedded) {
    return (
      <ThemeProvider forceColor="light">
        <main className="flex min-h-full flex-1 flex-col bg-[var(--wms-bg)] p-3">{children}</main>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <AlertSoundListener />
      <div className="flex min-h-full flex-1 bg-[var(--wms-bg)]">
        <Sidebar
          activeLocationId={activeLocationId}
          pinned={effectivePinned}
          onTogglePin={togglePin}
          open={open}
          onOpenChange={onOpenChange}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header: hamburger now shown on every viewport when the
              sidebar isn't pinned. Pinned mode mirrors the original
              md:hidden behaviour (header only appears on small
              viewports, since the sidebar already sits in flow). */}
          <header
            className={`sticky top-0 z-30 ${effectivePinned ? "flex md:hidden" : "flex"} min-h-12 shrink-0 items-center gap-3 border-b border-[var(--wms-border)] bg-[var(--wms-surface)]/95 px-3 py-2 backdrop-blur-md`}
          >
            <button
              type="button"
              aria-expanded={open}
              aria-controls="wms-sidebar"
              aria-label="Open navigation menu"
              className="rounded-md p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)] max-md:p-2.5"
              onClick={() => setOpen(true)}
            >
              <Menu className="h-5 w-5" strokeWidth={1.75} />
            </button>
            {/* Brand → Dashboard (a tap on the page you're on reloads it, like the sidebar). */}
            <Link
              href="/dashboard"
              onClick={(e) => {
                if (pathname === "/dashboard") {
                  e.preventDefault();
                  window.location.reload();
                }
              }}
              className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-sm font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] max-md:hidden"
            >
              {/* The Carbon mark, drawn in the text colour: white on the dark theme. */}
              <span
                aria-hidden
                className="inline-block h-7 w-7 shrink-0"
                style={{
                  backgroundColor: "var(--wms-fg)",
                  WebkitMaskImage: "url(/carbon-logo-mark-bold.png)",
                  maskImage: "url(/carbon-logo-mark-bold.png)",
                  WebkitMaskRepeat: "no-repeat",
                  maskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskPosition: "center",
                  WebkitMaskSize: "contain",
                  maskSize: "contain",
                }}
              />
              <span className="truncate">CarbonWMS</span>
            </Link>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--wms-fg)] md:hidden">
              {pageTitle(pathname)}
            </span>
          </header>
          <main
            className={`flex flex-1 flex-col ${
              forceCollapsed ? "p-0" : "p-5 max-md:p-3 max-md:pb-24 md:p-7 lg:p-8"
            }`}
          >
            {banner}
            {children}
          </main>
        </div>
        {!forceCollapsed ? <MobileTabBar onMenu={() => setOpen(true)} /> : null}
        <SyncProgressFloater />
      </div>
    </ThemeProvider>
  );
}
