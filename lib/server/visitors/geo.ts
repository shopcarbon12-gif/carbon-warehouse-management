/**
 * The city a visitor's IP belongs to (owner, 2026-10-21). An IP locates the
 * visitor's internet provider's area — a city or its suburb, sometimes the
 * next town — never a street; anything finer needs the visitor's own consent
 * (the browser's location prompt), which the store does not ask for.
 *
 * DB-IP's free city API (CC BY 4.0, https://db-ip.com — the Shield's country
 * list comes from the same provider): 1,000 lookups a day, so each IP is looked
 * up once and kept 30 days in ip_geo_cache, and this process stops at 900 a day.
 * A slow or failed lookup returns null — the visitor is recorded without a city.
 */
import type { Pool } from "pg";

export type IpGeo = { city: string | null; region: string | null; regionCode: string | null; country: string | null };

const DAILY_LIMIT = 900;
let day = "";
let used = 0;

export async function ipCity(pool: Pool, ip: string | null | undefined): Promise<IpGeo | null> {
  if (!ip) return null;
  try {
    const hit = await pool.query<{ city: string | null; region: string | null; region_code: string | null; country: string | null }>(
      `SELECT city, region, region_code, country FROM ip_geo_cache WHERE ip = $1 AND at > now() - interval '30 days'`,
      [ip],
    );
    const c = hit.rows[0];
    if (c) return { city: c.city, region: c.region, regionCode: c.region_code, country: c.country };
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; used = 0; }
    if (used >= DAILY_LIMIT) return null;
    used++;
    const r = await fetch(`https://api.db-ip.com/v2/free/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { city?: string; stateProv?: string; stateProvCode?: string; countryCode?: string; errorCode?: string };
    if (j.errorCode) return null;
    const geo: IpGeo = { city: j.city || null, region: j.stateProv || null, regionCode: j.stateProvCode || null, country: j.countryCode || null };
    await pool.query(
      `INSERT INTO ip_geo_cache (ip, country, region, region_code, city) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ip) DO UPDATE SET country = EXCLUDED.country, region = EXCLUDED.region, region_code = EXCLUDED.region_code, city = EXCLUDED.city, at = now()`,
      [ip, geo.country, geo.region, geo.regionCode, geo.city],
    );
    return geo;
  } catch {
    return null;
  }
}

/** "Lockhart, FL" in the US and Canada (the state says it), "Haifa, Israel" elsewhere; null without a city. */
export function placeWords(city: string | null, regionCode: string | null, region: string | null, countryName: string | null, country: string | null): string | null {
  if (!city) return null;
  if ((country === "US" || country === "CA") && regionCode) return `${city}, ${regionCode}`;
  return [city, countryName || region].filter(Boolean).join(", ");
}
