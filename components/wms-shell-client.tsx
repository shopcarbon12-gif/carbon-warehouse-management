"use client";

import { useCallback, useState } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ThemeProvider } from "@/components/theme/theme-provider";

export function WmsShellClient({
  activeLocationId,
  banner,
  children,
}: {
  activeLocationId: string;
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const onMobileOpenChange = useCallback((open: boolean) => {
    setMobileOpen(open);
  }, []);

  return (
    <ThemeProvider>
      <div className="flex min-h-full flex-1 bg-[var(--wms-bg)]">
        <Sidebar
          activeLocationId={activeLocationId}
          mobileOpen={mobileOpen}
          onMobileOpenChange={onMobileOpenChange}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-[var(--wms-border)] bg-[var(--wms-surface)]/95 px-3 backdrop-blur-md md:hidden">
          <button
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="wms-sidebar"
            aria-label="Open navigation menu"
            className="rounded-md p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" strokeWidth={1.75} />
          </button>
          <span className="truncate text-sm font-semibold text-[var(--wms-fg)]">
            Carbon WMS
          </span>
        </header>
          <main className="flex flex-1 flex-col p-4 md:p-6">
            {banner}
            {children}
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
}
