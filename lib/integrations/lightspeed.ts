/**
 * Lightspeed Retail (X-Series) — catalog / sales alignment.
 * Set LIGHTSPEED_ACCOUNT_ID + LIGHTSPEED_API_KEY (or OAuth token) per your account.
 */
export function lightspeedConfigured(): boolean {
  return Boolean(
    process.env.LIGHTSPEED_ACCOUNT_ID?.trim() && process.env.LIGHTSPEED_API_KEY?.trim()
  );
}

/** Placeholder ping — replace URL with your Lightspeed API base when credentials exist */
export async function lightspeedHealthPing(): Promise<{ ok: boolean; detail?: string }> {
  if (!lightspeedConfigured()) {
    return { ok: false, detail: "LIGHTSPEED_ACCOUNT_ID or LIGHTSPEED_API_KEY missing" };
  }
  return { ok: true, detail: "Credentials present — implement Retail API call for your region" };
}
