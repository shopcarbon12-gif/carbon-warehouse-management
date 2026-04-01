import { getSession } from "@/lib/get-session";
import { HandheldSettingsWorkspace } from "@/components/settings/handheld-settings-workspace";

export const dynamic = "force-dynamic";

export default async function HandheldSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Handheld settings</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          System, inventory, transfer, encoding, and on-screen templates for Carbon WMS mobile.
        </p>
      </div>
      <HandheldSettingsWorkspace />
    </div>
  );
}
