import { SyncPanel } from "./sync-panel";

export default function SyncPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">
        Sync &amp; reconciliation
      </h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Queue jobs in Postgres; run <code className="text-[var(--accent)]">npm run worker</code>{" "}
        (or a second Coolify service) to process them.
      </p>
      <SyncPanel />
    </div>
  );
}
