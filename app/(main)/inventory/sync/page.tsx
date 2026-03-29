import { SyncDashboard } from "@/components/inventory/sync/sync-dashboard";

export default function InventorySyncPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">
          Lightspeed sync
        </h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Manual trigger runs immediately (credentials from{" "}
          <code className="text-slate-600">infrastructure_settings</code> + env), upserting{" "}
          <code className="text-teal-500/90">matrices</code> and{" "}
          <code className="text-teal-500/90">custom_skus</code>. History below reads from{" "}
          <code className="text-slate-600">sync_jobs</code>.
        </p>
      </div>
      <SyncDashboard />
    </div>
  );
}
