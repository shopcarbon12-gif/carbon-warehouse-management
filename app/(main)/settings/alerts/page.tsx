import { getSession } from "@/lib/get-session";
import { AlertsControl } from "@/components/wms-alerts";

export const dynamic = "force-dynamic";

/** Phone/computer alerts for Shopify orders and Studio night-batch results (owner 2026-10-19). */
export default async function AlertsSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Alerts</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          A notification on this phone or computer for every paid Shopify order and every Studio night-batch result.
        </p>
      </div>
      <div className="max-w-xl space-y-3 font-mono text-sm text-[var(--wms-fg)]">
        <AlertsControl />
        <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--wms-muted)]">
          <li>Turn alerts on once on each device: in Chrome at wms.shopcarbon.com (not inside the CarbonWMS-PC app).</li>
          <li>Shopify order: “New Shopify order #… · $… · items” — tap to open Sales.</li>
          <li>Studio: “Studio · product · model colour — N of 4 pictures ready” — tap to open that product&apos;s Studio.</li>
          <li>Sound: the phone plays its normal notification sound; an open WMS page also plays a cash-register sound for orders and a chime for Studio.</li>
        </ul>
      </div>
    </div>
  );
}
