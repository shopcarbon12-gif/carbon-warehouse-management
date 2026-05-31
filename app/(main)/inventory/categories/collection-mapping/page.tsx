import { getSession } from "@/lib/get-session";
import ShopifyCollectionMapping from "@/components/shopify-collection-mapping";

export const dynamic = "force-dynamic";

// Shopify Collection Mapping, ported from carbon-gen and mounted under the
// Categories area. The (main) layout already applies the WMS shell + session
// gate; this just hosts the (client) workspace component.
export default async function CollectionMappingPage() {
  const session = await getSession();
  if (!session) return null;
  return <ShopifyCollectionMapping />;
}
