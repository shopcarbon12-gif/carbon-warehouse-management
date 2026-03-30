import { getSession } from "@/lib/get-session";
import { StatusLabelsWorkspace } from "@/components/settings/status-labels-workspace";

export const dynamic = "force-dynamic";

export default async function StatusLabelsSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Manage status labels</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Senitron-style status flags · toggles persist to <code className="text-slate-600">status_labels</code>.
        </p>
      </div>
      <StatusLabelsWorkspace />
    </div>
  );
}
