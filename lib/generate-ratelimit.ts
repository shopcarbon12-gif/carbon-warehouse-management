/** No-op generate rate limiter (admin-only Carbon Studio). See lib/seo-ratelimit. */
export async function checkGenerateRateLimit(
  _key: string,
): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}
