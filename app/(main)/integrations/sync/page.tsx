import { SyncDashboard } from "@/components/inventory/sync/sync-dashboard";

export default function InventorySyncPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
          Lightspeed sync
        </h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Manual trigger runs immediately (credentials from{" "}
          <code className="text-[var(--wms-muted)]">infrastructure_settings</code> + env). Live pull tries{" "}
          <strong className="text-[var(--wms-muted)]">R-Series</strong> (Account ID + OAuth, carbon-gen style)
          first, then Retail X-Series <code className="text-[var(--wms-muted)]">/api/2.0/products</code>, then
          simulated data. Upserts <code className="text-teal-500/90">matrices</code> and{" "}
          <code className="text-teal-500/90">custom_skus</code>. History reads from{" "}
          <code className="text-[var(--wms-muted)]">sync_jobs</code>.
        </p>
      </div>
      <SyncDashboard />
    </div>
  );
}
