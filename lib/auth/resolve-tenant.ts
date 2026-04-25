import type { Pool } from "pg";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";

/**
 * Dual auth resolver — mirrors `app/api/inventory/upload/route.ts`.
 *
 * Returns `{ tenantId, userId, deviceId }` on success.
 *  - Session path: `userId = session.sub`, `deviceId = explicit param or null`.
 *  - Edge-key path: `userId = null`, `deviceId` resolved from header/body, must
 *    match a registered device.
 *
 * Returns a `Response` (401/403) on failure that callers should pass through.
 */
export async function resolveTenantOrError(
  req: Request,
  pool: Pool,
  hintedDeviceId?: string,
): Promise<
  | { tenantId: string; userId: string | null; deviceId: string | null }
  | Response
> {
  const session = await getSessionFromRequest(req);
  if (session) {
    return {
      tenantId: session.tid,
      userId: session.sub,
      deviceId: hintedDeviceId?.trim() || null,
    };
  }

  const apiKey = extractEdgeApiKey(req);
  if (!verifyEdgeApiKey(apiKey)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const did = hintedDeviceId?.trim();
  if (!did) {
    return new Response(
      JSON.stringify({ error: "deviceId required for device requests" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const device = await resolveEdgeDeviceCached(pool, did);
  if (!device) {
    return new Response(JSON.stringify({ error: "Device not registered" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return { tenantId: device.tenantId, userId: null, deviceId: did };
}
