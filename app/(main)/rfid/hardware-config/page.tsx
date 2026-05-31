import { HardwareConfigWorkspace } from "@/components/hardware-config/hardware-config-workspace";

export default function HardwareConfigPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Hardware Config
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Define <strong className="text-[var(--wms-muted)]">zones</strong>, place fixed
          readers and antennas under them, and register{" "}
          <strong className="text-[var(--wms-muted)]">Carbon CDM</strong> agents that drive
          the hardware. Each location may have multiple zones (e.g.,{" "}
          <strong className="text-[var(--wms-muted)]">Warehouse</strong> and{" "}
          <strong className="text-[var(--wms-muted)]">Store</strong>) under one CDM agent.
        </p>
      </div>
      <HardwareConfigWorkspace />
    </div>
  );
}
