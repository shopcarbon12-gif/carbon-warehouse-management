/** Device API: shared secret from Coolify env (never commit). */
export function verifyDeviceKey(headerValue: string | null): boolean {
  const expected = process.env.WMS_DEVICE_KEY?.trim();
  if (!expected) return false;
  return headerValue === expected;
}
