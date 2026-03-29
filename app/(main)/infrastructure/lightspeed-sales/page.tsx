import { LightspeedSalesWorkspace } from "@/components/infrastructure/lightspeed-sales-workspace";

export const dynamic = "force-dynamic";

export default function LightspeedSalesPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Lightspeed sales</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Read-only list from R-Series <code className="text-slate-600">Sale</code> API (same account as
          catalog sync). Admin only. For tokens, use{" "}
          <strong className="text-slate-400">Connect Lightspeed</strong> on Settings or set{" "}
          <code className="text-slate-600">LS_REFRESH_TOKEN</code> in Coolify.
        </p>
      </div>
      <LightspeedSalesWorkspace />
    </div>
  );
}
