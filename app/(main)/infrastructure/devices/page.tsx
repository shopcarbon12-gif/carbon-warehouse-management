import { DevicesWorkspace } from "@/components/infrastructure/devices/devices-workspace";

export default function InfrastructureDevicesPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Devices</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Registry for Zebra printers and Carbon RFID edge hardware. Assign each device to a
          warehouse location (and optionally a bin) for scan provenance.
        </p>
      </div>
      <DevicesWorkspace />
    </div>
  );
}
