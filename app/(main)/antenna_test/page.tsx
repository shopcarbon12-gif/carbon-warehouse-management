import { AntennaTestWorkspace } from "@/components/antenna-test/antenna-test-workspace";

export const dynamic = "force-dynamic";

export default function AntennaTestPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <header className="border-b border-[var(--wms-border)] pb-4">
        <span className="inline-block rounded-full bg-[var(--wms-bg)] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--wms-muted)]">
          Diagnostic
        </span>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-[var(--wms-fg)]">
          Antenna Test
        </h1>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-[var(--wms-muted)]">
          Pick a reader and antenna, set the radio knobs, click{" "}
          <strong className="text-[var(--wms-fg)]">Start scan</strong> and watch
          every tag in range stream into the table in near-real-time. Sweep mode
          walks the power from low to high so you get each tag&apos;s first-read
          power as a clean distance proxy. Drop in a list of reference EPCs to
          turn this into a hard pass/fail check for a candidate antenna position.
          Other readers keep running their normal scans while a test is active —
          only the chosen reader is preempted.
        </p>
      </header>
      <AntennaTestWorkspace />
    </div>
  );
}
