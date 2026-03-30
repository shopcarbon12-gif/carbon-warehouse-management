import { WmsShellClient } from "@/components/wms-shell-client";

export function WmsShell({
  activeLocationId,
  banner,
  children,
}: {
  activeLocationId: string;
  /** Optional server-rendered strip (e.g. local DB hint). */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <WmsShellClient activeLocationId={activeLocationId} banner={banner}>
      {children}
    </WmsShellClient>
  );
}
