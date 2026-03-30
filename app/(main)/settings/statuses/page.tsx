import { getSession } from "@/lib/get-session";
import { StatusLabelsWorkspace } from "@/components/settings/status-labels-workspace";

export const dynamic = "force-dynamic";

export default async function StatusLabelsSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Manage asset status (Clean 10)</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Hard-wired Carbon WMS rules — only display text and legacy system IDs are editable. Data lives in{" "}
          <code className="text-[var(--wms-fg)]/80">status_labels</code>.
        </p>
      </div>
      <StatusLabelsWorkspace />
    </div>
  );
}
