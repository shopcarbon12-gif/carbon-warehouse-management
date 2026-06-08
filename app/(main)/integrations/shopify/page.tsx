import { getSession } from "@/lib/get-session";
import { ShopifyImagesPanel } from "@/components/infrastructure/settings/shopify-images-panel";

export const dynamic = "force-dynamic";

export default async function ShopifyIntegrationPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--foreground)]">Shopify</h1>
        <p className="mt-1 font-mono text-sm text-[var(--muted)]">
          Product imagery pulled from your Shopify store into the catalog, POS, and handheld.
        </p>
      </div>
      <ShopifyImagesPanel />
    </div>
  );
}
