/**
 * Edge firehose authentication (handhelds).
 * Primary: header `x-edge-api-key` === env `EDGE_API_KEY`.
 * Fallbacks: `WMS_EDGE_INGEST_KEY`, then `WMS_DEVICE_KEY`, plus legacy header names.
 */

function expectedEdgeSecrets(): string[] {
  const keys = [
    process.env.EDGE_API_KEY?.trim(),
    process.env.WMS_EDGE_INGEST_KEY?.trim(),
    process.env.WMS_DEVICE_KEY?.trim(),
  ].filter((k): k is string => Boolean(k));
  return [...new Set(keys)];
}

export function extractEdgeApiKey(req: Request): string | null {
  const h = (name: string) => req.headers.get(name)?.trim() || null;
  return (
    h("x-edge-api-key") ??
    h("X-Edge-Api-Key") ??
    h("x-wms-edge-key") ??
    h("x-wms-device-key") ??
    extractBearer(req)
  );
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

export function verifyEdgeApiKey(headerValue: string | null): boolean {
  const v = headerValue?.trim();
  if (!v) return false;
  const expected = expectedEdgeSecrets();
  if (expected.length === 0) return false;
  return expected.some((e) => e === v);
}
