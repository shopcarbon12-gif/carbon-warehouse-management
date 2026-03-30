/**
 * Public origin for Lightspeed OAuth (authorize + callback redirects).
 * Matches carbon-gen `app/api/lightspeed/auth` / `callback`: `NEXT_PUBLIC_BASE_URL` first,
 * then WMS-specific `WMS_APP_PUBLIC_BASE_URL` for Coolify parity.
 */

import { WMS_LOCAL_DEV_ORIGIN } from "@/lib/constants/wms-public-origin";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function lightspeedOAuthPublicBase(): string {
  const fromEnv =
    normalizeText(process.env.NEXT_PUBLIC_BASE_URL) ||
    normalizeText(process.env.WMS_APP_PUBLIC_BASE_URL) ||
    normalizeText(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  const base = fromEnv.replace(/\/$/, "");
  if (base) return base;
  return WMS_LOCAL_DEV_ORIGIN;
}
