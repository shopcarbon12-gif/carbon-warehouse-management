"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { SyncProgressFloater } from "@/components/inventory/sync/sync-progress-floater";

/** localStorage key for the pin state (sidebar stays open across navigation). */
const PIN_KEY = "wms.sidebar.pinned";

export function WmsShellClient({
  activeLocationId,
  banner,
  children,
}: {
  activeLocationId: string;
  banner?: React.ReactNode;
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

  return (
    <ThemeProvider>
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
              className="rounded-md p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              onClick={() => setOpen(true)}
            >
              <Menu className="h-5 w-5" strokeWidth={1.75} />
            </button>
            <span className="truncate text-sm font-semibold text-[var(--wms-fg)]">
              CarbonWMS
            </span>
          </header>
          <main
            className={`flex flex-1 flex-col ${
              forceCollapsed ? "p-0" : "p-5 md:p-7 lg:p-8"
            }`}
          >
            {banner}
            {children}
          </main>
        </div>
        <SyncProgressFloater />
      </div>
    </ThemeProvider>
  );
}
