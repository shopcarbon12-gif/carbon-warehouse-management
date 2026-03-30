import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import type { Pool } from "pg";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";
import type { ResolvedEdgeDevice } from "@/lib/server/edge-device-resolve";

export type HandheldDeviceAuthResult =
  | { ok: true; device: ResolvedEdgeDevice }
  | { ok: false; status: number; error: string };

/**
 * Handheld routes: either a valid edge API key, or a mobile Bearer session whose tenant
 * owns the resolved device (matched by android_id, devices.id, name, or config aliases).
 */
export async function authorizeHandheldDeviceRequest(
  pool: Pool,
  req: Request,
  deviceId: string,
): Promise<HandheldDeviceAuthResult> {
  const trimmed = deviceId.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "deviceId required" };
  }

  const apiKey = extractEdgeApiKey(req);
  if (verifyEdgeApiKey(apiKey)) {
    const device = await resolveEdgeDeviceCached(pool, trimmed);
    if (!device) {
      return { ok: false, status: 403, error: "Device not registered" };
    }
    return { ok: true, device };
  }

  const session = await getSessionFromRequest(req);
  if (!session) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const device = await resolveEdgeDeviceCached(pool, trimmed);
  if (!device) {
    return { ok: false, status: 403, error: "Device not registered" };
  }
  if (device.tenantId !== session.tid) {
    return { ok: false, status: 403, error: "Device not registered" };
  }
  return { ok: true, device };
}
