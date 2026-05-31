// Local API alias for collection mapping so the page can work even when /api/shopify/* routes are unavailable in this runtime.
import { GET as ShopifyCollectionMappingGET, POST as ShopifyCollectionMappingPOST } from "@/app/api/shopify/collection-mapping/route";

// Keep route segment config local in this file so Next can statically detect it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  return ShopifyCollectionMappingGET(request as never);
}

export async function POST(request: Request) {
  return ShopifyCollectionMappingPOST(request as never);
}
