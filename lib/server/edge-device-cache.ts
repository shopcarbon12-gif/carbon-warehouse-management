import type { Pool } from "pg";
import type { ResolvedEdgeDevice } from "@/lib/server/edge-device-resolve";
import { resolveEdgeDevice } from "@/lib/server/edge-device-resolve";

const TTL_MS = 60_000;
const MAX = 512;
const cache = new Map<string, { value: ResolvedEdgeDevice; exp: number }>();

function prune(): void {
  if (cache.size <= MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.exp <= now) cache.delete(k);
  }
  while (cache.size > MAX) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

export async function resolveEdgeDeviceCached(
  pool: Pool,
  deviceId: string,
): Promise<ResolvedEdgeDevice | null> {
  const key = deviceId.trim().toLowerCase();
  if (!key) return null;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.value;

  const v = await resolveEdgeDevice(pool, deviceId);
  if (v) {
    cache.set(key, { value: v, exp: now + TTL_MS });
    prune();
  }
  return v;
}
