"use client";

import { useCallback, useState } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";

export function WmsShellClient({
  activeLocationId,
  children,
}: {
  activeLocationId: string;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const onMobileOpenChange = useCallback((open: boolean) => {
    setMobileOpen(open);
  }, []);

  return (
    <div className="flex min-h-full flex-1 bg-[var(--background)]">
      <Sidebar
        activeLocationId={activeLocationId}
        mobileOpen={mobileOpen}
        onMobileOpenChange={onMobileOpenChange}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-slate-800/80 bg-zinc-950/95 px-3 backdrop-blur-md md:hidden">
          <button
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="wms-sidebar"
            aria-label="Open navigation menu"
            className="rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" strokeWidth={1.75} />
          </button>
          <span className="truncate text-sm font-semibold text-slate-200">
            Carbon WMS
          </span>
        </header>
        <main className="flex flex-1 flex-col p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
