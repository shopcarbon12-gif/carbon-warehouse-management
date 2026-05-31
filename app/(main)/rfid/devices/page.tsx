import { DevicesWorkspace } from "@/components/infrastructure/devices/devices-workspace";

export default function InfrastructureDevicesPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Devices</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Registry for printers, fixed readers, and <strong className="text-[var(--wms-muted)]">handhelds</strong> that use
          the CarbonWMS app. Phones appear under the <strong className="text-[var(--wms-muted)]">Hand-held readers</strong> tab
          after the app signs in (device ping). Until an admin authorizes them, they also show under{" "}
          <strong className="text-[var(--wms-muted)]">Settings → Device binding</strong> as pending.
        </p>
      </div>
      <DevicesWorkspace />
    </div>
  );
}
