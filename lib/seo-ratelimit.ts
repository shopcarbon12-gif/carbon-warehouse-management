/**
 * No-op rate limiter for the SEO routes (admin-only, internal use). carbon-gen
 * gates these behind Upstash Redis; WMS runs them for authenticated admins, so
 * a permissive stub keeps the ported optimize route unchanged without pulling
 * in the Upstash dependency. Swap for a real limiter later if needed.
 */
export async function checkGenerateRateLimit(
  _key: string,
): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}
