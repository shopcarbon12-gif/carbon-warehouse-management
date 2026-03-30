import { getSession } from "@/lib/get-session";
import { ThemeSettingsWorkspace } from "@/components/theme/theme-settings-workspace";

export const dynamic = "force-dynamic";

export default async function ThemeSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Theme &amp; style</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Color mode and font scale for Carbon WMS.
        </p>
      </div>
      <ThemeSettingsWorkspace />
    </div>
  );
}
