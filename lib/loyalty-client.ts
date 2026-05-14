/**
 * Server-side HTTP client for rewards.shopcarbon.com.
 *
 * Used by the WMS Loyalty pages to fetch balances, ledger entries, and
 * to post manual adjustments. Uses LOYALTY_API_KEY (same value as the
 * loyalty service and Carbon-POS).
 */
const BASE = process.env.LOYALTY_API_BASE_URL?.trim() || "https://rewards.shopcarbon.com";
const KEY = process.env.LOYALTY_API_KEY?.trim() || "";

export type LoyaltyBalance = {
  customer_id: number;
  balance: number;
  dollars_value: number;
  tier: string | null;
  recent: Array<{
    id: number;
    delta_points: number;
    reason: string;
    source: string;
    source_ref: string | null;
    created_at: string;
  }>;
};

export async function loyaltyGet<T>(path: string): Promise<T | null> {
  if (!BASE || !KEY) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loyaltyPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  if (!BASE || !KEY) return { ok: false, status: 0, message: "loyalty_not_configured" };
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, status: res.status, message: j.message ?? `http_${res.status}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message };
  }
}
