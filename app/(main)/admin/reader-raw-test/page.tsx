import { ReaderRawTestWorkspace } from "@/components/admin/reader-raw-test/reader-raw-test-workspace";

export const dynamic = "force-dynamic";

export default function ReaderRawTestPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <header className="border-b border-[var(--wms-border)] pb-4">
        <span className="inline-block rounded-full bg-amber-500/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-300">
          Admin diagnostic · no rules
        </span>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-[var(--wms-fg)]">
          Reader raw test
        </h1>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-[var(--wms-muted)]">
          Spawns <code className="rounded bg-[var(--wms-surface-elevated)] px-1 py-0.5">new_monsoonreader --console</code>{" "}
          directly against a bridge IP you type. No WMS data, no agent, no
          rules: this dev WMS owns the binary, the binary owns the bridge,
          you see exactly what the chip emits. Pause the reader in production
          first so the bridge is free (single-client WIZnet). Nothing is
          written to the database; closing the tab kills the binary.
        </p>
      </header>
      <ReaderRawTestWorkspace />
    </div>
  );
}
