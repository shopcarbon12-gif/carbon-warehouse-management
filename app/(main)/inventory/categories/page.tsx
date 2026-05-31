import { getSession } from "@/lib/get-session";
import ShopifyCollectionMapping from "@/components/shopify-collection-mapping";

export const dynamic = "force-dynamic";

// Categories now opens straight into the Shopify Collection Mapping workspace.
// The old category manager is reachable from the "Legacy" button under the KPI
// row inside that workspace.
export default async function CategoriesPage() {
  const session = await getSession();
  if (!session) return null;
  return <ShopifyCollectionMapping />;
}
