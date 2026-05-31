/**
 * WMS shim for the ported Shopify Collection Mapping feature.
 *
 * Used only to compute a default OAuth redirect origin in getShopifyConfig.
 * The mapping read/write path uses the static admin token, so this is
 * low-stakes; we honor an explicit override, then forwarded host headers, then
 * the known WMS public origin.
 */
import type { NextRequest } from "next/server";

export function resolvePublicAppOrigin(req: NextRequest): string {
  const configured = (process.env.PUBLIC_APP_ORIGIN || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host =
    req.headers.get("x-forwarded-host") || req.headers.get("host") || "wms.shopcarbon.com";
  return `${proto}://${host}`;
}
