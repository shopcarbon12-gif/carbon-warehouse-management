import { getSession } from "@/lib/get-session";
import { ShopifyImagesPanel } from "@/components/infrastructure/settings/shopify-images-panel";
import { ShopifyTranslatePanel } from "@/components/infrastructure/settings/shopify-translate-panel";
import { ShopifyAdsSyncPanel } from "@/components/infrastructure/settings/shopify-ads-sync-panel";

export const dynamic = "force-dynamic";

export default async function ShopifyIntegrationPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--foreground)]">Shopify</h1>
        <p className="mt-1 font-mono text-sm text-[var(--muted)]">
          Product pictures from your Shopify store, store translations, and the products your Google and Meta ads advertise.
        </p>
      </div>
      <ShopifyImagesPanel />
      <ShopifyTranslatePanel />
      <ShopifyAdsSyncPanel />
    </div>
  );
}
