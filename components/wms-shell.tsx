import Link from "next/link";
import { WmsNav } from "@/components/wms-nav";
import { LocationSwitcher } from "@/components/location-switcher";
import { logoutAction } from "@/app/actions/auth";

export function WmsShell({
  activeLocationId,
  children,
}: {
  activeLocationId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--surface-border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--surface-border)] px-4 py-4">
          <Link href="/dashboard" className="block">
            <span className="font-mono text-[0.65rem] font-medium uppercase tracking-[0.2em] text-[var(--accent)]">
              WMS
            </span>
            <span className="mt-0.5 block text-base font-semibold tracking-tight text-[var(--foreground)]">
              Carbon WMS
            </span>
            <span className="mt-1 block font-mono text-xs text-[var(--muted)]">
              Multi-location control
            </span>
          </Link>
        </div>
        <LocationSwitcher activeLocationId={activeLocationId} />
        <WmsNav />
        <div className="mt-auto border-t border-[var(--surface-border)] p-4 font-mono text-xs text-[var(--muted)]">
          <form action={logoutAction}>
            <button
              type="submit"
              className="text-left font-mono text-xs text-[var(--accent)] hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center border-b border-[var(--surface-border)] px-6">
          <span className="font-mono text-xs text-[var(--muted)]">
            <Link href="/dashboard" className="hover:text-[var(--accent)]">
              Home
            </Link>
          </span>
        </header>
        <div className="flex-1 p-6">{children}</div>
      </div>
    </div>
  );
}
