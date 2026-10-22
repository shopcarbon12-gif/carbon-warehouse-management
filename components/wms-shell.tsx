import { WmsShellClient } from "@/components/wms-shell-client";

export function WmsShell({
  activeLocationId,
  banner,
  embedded = false,
  children,
}: {
  activeLocationId: string;
  /** Optional server-rendered strip (e.g. local DB hint). */
  banner?: React.ReactNode;
  /** Opened inside the CarbonGradingAI app: the page only, no CarbonWMS menus. */
  embedded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <WmsShellClient activeLocationId={activeLocationId} banner={banner} embedded={embedded}>
      {children}
    </WmsShellClient>
  );
}
