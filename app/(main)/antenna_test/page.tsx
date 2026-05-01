import { AntennaTestWorkspace } from "@/components/antenna-test/antenna-test-workspace";

export const dynamic = "force-dynamic";

export default function AntennaTestPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Antenna Test
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Pick a reader and antenna, set the radio knobs, click{" "}
          <strong className="text-[var(--wms-muted)]">Start scan</strong> to see every tag in
          range update its RSSI live. Stays running until you click Stop. Other readers
          continue normal scanning while a test is active.
        </p>
      </div>
      <AntennaTestWorkspace />
    </div>
  );
}
