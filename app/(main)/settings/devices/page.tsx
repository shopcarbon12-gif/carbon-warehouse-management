import { getSession } from "@/lib/get-session";
import { HandheldBindingsWorkspace } from "@/components/settings/handheld-bindings-workspace";

export const dynamic = "force-dynamic";

export default async function HandheldDevicesPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Handheld device binding</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          After a user signs in on the mobile app, the device registers its Android ID against the active location. Approve
          pending readers here (Zebra serial / Android ID).{" "}
          <strong className="font-medium text-[var(--wms-fg)]">
            This table is only the pending queue — after you click Authorize, the device disappears from here but stays in
            the registry.
          </strong>{" "}
          View all handhelds under <strong className="font-medium text-[var(--wms-fg)]">Infrastructure → Devices</strong>{" "}
          (Hand-held readers).
        </p>
      </div>
      <HandheldBindingsWorkspace />
    </div>
  );
}
