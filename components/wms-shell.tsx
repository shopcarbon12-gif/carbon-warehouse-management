import { WmsShellClient } from "@/components/wms-shell-client";

export function WmsShell({
  activeLocationId,
  children,
}: {
  activeLocationId: string;
  children: React.ReactNode;
}) {
  return (
    <WmsShellClient activeLocationId={activeLocationId}>
      {children}
    </WmsShellClient>
  );
}
