import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { CatalogWorkspace } from "@/components/inventory/catalog/catalog-workspace";

export const dynamic = "force-dynamic";

export default async function ProductCatalogPage() {
  const session = await getSession();
  if (!session) return null;

  const canTriggerLightspeedSync = session.role?.trim().toLowerCase() === "admin";
  const canManageCatalog = canTriggerLightspeedSync;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 pb-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Inventory catalog</h1>
          <p className="mt-1 font-mono text-xs text-slate-500">
            Lightspeed item lines (SKU, vendor, POS on-hand when available) and a separate RFID view with
            active EPCs.
          </p>
        </div>
        <Link
          href="/inventory"
          className="shrink-0 font-mono text-xs text-teal-400 hover:text-teal-300 hover:underline"
        >
          Legacy inventory
        </Link>
      </div>

      <CatalogWorkspace
        canTriggerLightspeedSync={canTriggerLightspeedSync}
        canManageCatalog={canManageCatalog}
      />
    </div>
  );
}
