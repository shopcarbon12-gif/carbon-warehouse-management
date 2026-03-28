/**
 * Senitron RFID — https://app.senitron.net
 * Use SENITRON_API_BASE (default app.senitron.net) + SENITRON_API_KEY.
 */
export function senitronBaseUrl(): string {
  const b = process.env.SENITRON_API_BASE?.trim() || "https://app.senitron.net";
  return b.replace(/\/$/, "");
}

export function senitronConfigured(): boolean {
  return Boolean(process.env.SENITRON_API_KEY?.trim());
}

export async function senitronHealthPing(): Promise<{ ok: boolean; detail?: string }> {
  if (!senitronConfigured()) {
    return { ok: false, detail: "SENITRON_API_KEY missing" };
  }
  const base = senitronBaseUrl();
  try {
    const res = await fetch(`${base}/`, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    return { ok: res.ok || res.status === 405 || res.status === 403, detail: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error";
    return { ok: false, detail: msg };
  }
}
