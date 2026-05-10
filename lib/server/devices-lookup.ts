import type { PoolClient } from "pg";

/**
 * Resolve a handheld device hint (the `x-wms-device-id` header value or a
 * stored `input.deviceId`) into the device row's UUID. Mirrors the lookup
 * in `app/api/handheld/epc-queue/route.ts` so handheld-touching paths can
 * write `items.source_device_id` consistently regardless of which client
 * field the operator's app populated.
 *
 * Match order (any of):
 *   - exact `devices.id` (UUID)
 *   - `devices.android_id` (case-insensitive)
 *   - `devices.config->>'deviceId'` alias
 *   - `devices.config->>'edgeDeviceId'` alias
 *   - `devices.name` (case-insensitive — last resort, can collide)
 *
 * Filters: device_type='handheld_reader' AND is_authorized=true. An
 * unauthorized handheld scanning EPCs shouldn't get attribution; that's
 * an operator-trust signal.
 *
 * Returns null when no hint, no match, or multiple matches (ambiguous —
 * caller writes NULL rather than guessing).
 */
export async function resolveHandheldDeviceId(
  client: PoolClient,
  hint: string | null | undefined,
  tenantId: string,
): Promise<string | null> {
  const h = (hint ?? "").trim();
  if (!h) return null;
  const r = await client.query<{ id: string }>(
    `SELECT d.id::text
       FROM devices d
      WHERE (
        d.id::text                                 = $1::text
        OR lower(trim(coalesce(d.android_id, ''))) = lower(trim($1::text))
        OR lower(trim(coalesce(d.config->>'deviceId', ''))) = lower(trim($1::text))
        OR lower(trim(coalesce(d.config->>'edgeDeviceId', ''))) = lower(trim($1::text))
        OR lower(trim(d.name))                     = lower(trim($1::text))
      )
        AND d.device_type = 'handheld_reader'
        AND coalesce(d.is_authorized, false) = true
        AND d.tenant_id = $2::uuid
      LIMIT 2`,
    [h, tenantId],
  );
  if (r.rowCount !== 1) return null;
  return r.rows[0]!.id;
}
