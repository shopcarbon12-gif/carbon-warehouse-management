/**
 * Carbon Shield dashboard data (Shopify → Carbon Shield). Read-only.
 * "Visitors" are distinct browsers (the theme script's random id); "views"
 * are checked page views. Raw rows cover 7 days; the 30-day chart comes from
 * the daily totals.
 */
import type { Pool } from "pg";
import { settingsFromRow } from "./check";
import type { ShieldSettings } from "./verdict";

export type ShieldReport = {
  settings: ShieldSettings & { updatedAt: string | null; updatedBy: string | null };
  rules: { id: string; kind: string; value: string; action: string; note: string | null; createdAt: string; createdBy: string | null }[];
  windows: Record<"day" | "week", { views: number; visitors: number; botVisitors: number; botViews: number; goodBotViews: number }>;
  reasons: { reason: string; visitors: number; views: number }[];
  networks: { asn: number | null; org: string | null; visitors: number; botVisitors: number; views: number }[];
  countries: { country: string | null; visitors: number; botVisitors: number }[];
  sources: { source: string; visitors: number; botVisitors: number }[];
  ads: { ad: string; visitors: number; botVisitors: number }[];
  recent: {
    at: string;
    ip: string | null;
    visitorId: string | null;
    country: string | null;
    asn: number | null;
    org: string | null;
    reasons: string[];
    verdict: string;
    path: string | null;
    source: string | null;
    ua: string | null;
  }[];
  daily: { day: string; allow: number; block: number }[];
  status: {
    ipdbVersion: string | null;
    ipdbRefreshedAt: string | null;
    lastCheckAt: string | null;
    checksLastHour: number;
  };
};

export async function getShieldReport(pool: Pool): Promise<ShieldReport> {
  const [settings, rules, windows, reasons, networks, countries, sources, ads, recent, daily, ipdb, last] = await Promise.all([
    pool.query(`SELECT * FROM shield_settings WHERE id = 1`),
    pool.query(
      `SELECT id::text, kind, value, action, note, created_at, created_by_email FROM shield_rules ORDER BY created_at DESC`,
    ),
    pool.query<{ w: "day" | "week"; views: number; visitors: number; bot_visitors: number; bot_views: number; good_bot_views: number }>(
      `SELECT w,
              count(*)::int AS views,
              count(DISTINCT visitor_id)::int AS visitors,
              count(DISTINCT visitor_id) FILTER (WHERE would_verdict = 'block')::int AS bot_visitors,
              count(*) FILTER (WHERE would_verdict = 'block')::int AS bot_views,
              count(*) FILTER (WHERE good_bot IS NOT NULL)::int AS good_bot_views
         FROM (SELECT 'day' AS w UNION ALL SELECT 'week') ws
         JOIN shield_events e ON e.at > now() - CASE WHEN ws.w = 'day' THEN interval '24 hours' ELSE interval '7 days' END
        GROUP BY w`,
    ),
    pool.query<{ reason: string; visitors: number; views: number }>(
      `SELECT reason, count(DISTINCT visitor_id)::int AS visitors, count(*)::int AS views
         FROM shield_events, unnest(reasons) AS reason
        WHERE at > now() - interval '7 days' AND would_verdict = 'block'
        GROUP BY reason ORDER BY visitors DESC`,
    ),
    pool.query<{ asn: number | null; org: string | null; visitors: number; bot_visitors: number; views: number }>(
      `SELECT asn, max(as_org) AS org, count(DISTINCT visitor_id)::int AS visitors,
              count(DISTINCT visitor_id) FILTER (WHERE would_verdict = 'block')::int AS bot_visitors,
              count(*)::int AS views
         FROM shield_events WHERE at > now() - interval '7 days'
        GROUP BY asn ORDER BY views DESC LIMIT 25`,
    ),
    pool.query<{ country: string | null; visitors: number; bot_visitors: number }>(
      `SELECT country, count(DISTINCT visitor_id)::int AS visitors,
              count(DISTINCT visitor_id) FILTER (WHERE would_verdict = 'block')::int AS bot_visitors
         FROM shield_events WHERE at > now() - interval '7 days'
        GROUP BY country ORDER BY visitors DESC LIMIT 20`,
    ),
    pool.query<{ source: string; visitors: number; bot_visitors: number }>(
      `SELECT coalesce(source, 'direct') AS source, count(DISTINCT visitor_id)::int AS visitors,
              count(DISTINCT visitor_id) FILTER (WHERE would_verdict = 'block')::int AS bot_visitors
         FROM shield_events WHERE at > now() - interval '7 days' AND coalesce(source, '') <> 'internal'
        GROUP BY 1 ORDER BY visitors DESC LIMIT 12`,
    ),
    pool.query<{ ad: string; visitors: number; bot_visitors: number }>(
      `SELECT ad_click AS ad, count(DISTINCT visitor_id)::int AS visitors,
              count(DISTINCT visitor_id) FILTER (WHERE would_verdict = 'block')::int AS bot_visitors
         FROM shield_events WHERE at > now() - interval '7 days' AND ad_click IS NOT NULL
        GROUP BY 1 ORDER BY visitors DESC`,
    ),
    pool.query(
      `SELECT DISTINCT ON (coalesce(visitor_id, host(ip))) at, host(ip) AS ip, visitor_id, country, asn, as_org, reasons, verdict, path, source, ua
         FROM shield_events
        WHERE at > now() - interval '2 days' AND would_verdict = 'block'
        ORDER BY coalesce(visitor_id, host(ip)), at DESC
        LIMIT 400`,
    ),
    pool.query<{ day: string; allow: number; block: number }>(
      `SELECT day::text,
              coalesce(sum(visits) FILTER (WHERE would_verdict = 'allow'), 0)::int AS allow,
              coalesce(sum(visits) FILTER (WHERE would_verdict = 'block'), 0)::int AS block
         FROM shield_daily WHERE day > (now() AT TIME ZONE 'America/New_York')::date - 30
        GROUP BY day ORDER BY day`,
    ),
    pool.query<{ version: string; refreshed_at: string }>(`SELECT version, refreshed_at FROM shield_ipdb WHERE kind = 'v4'`),
    pool.query<{ last_at: string | null; last_hour: number }>(
      `SELECT max(at) AS last_at, count(*) FILTER (WHERE at > now() - interval '1 hour')::int AS last_hour
         FROM shield_events WHERE at > now() - interval '7 days'`,
    ),
  ]);

  const s = settings.rows[0];
  const w = (k: "day" | "week") => {
    const r = windows.rows.find((x) => x.w === k);
    return {
      views: r?.views ?? 0,
      visitors: r?.visitors ?? 0,
      botVisitors: r?.bot_visitors ?? 0,
      botViews: r?.bot_views ?? 0,
      goodBotViews: r?.good_bot_views ?? 0,
    };
  };
  const recentRows = (recent.rows as {
    at: Date;
    ip: string | null;
    visitor_id: string | null;
    country: string | null;
    asn: number | null;
    as_org: string | null;
    reasons: string[];
    verdict: string;
    path: string | null;
    source: string | null;
    ua: string | null;
  }[])
    .sort((a, b) => +new Date(b.at) - +new Date(a.at))
    .slice(0, 150);

  return {
    settings: {
      ...settingsFromRow(s),
      updatedAt: s?.updated_at ? new Date(s.updated_at).toISOString() : null,
      updatedBy: s?.updated_by_email ?? null,
    },
    rules: (rules.rows as { id: string; kind: string; value: string; action: string; note: string | null; created_at: Date; created_by_email: string | null }[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      action: r.action,
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
      createdBy: r.created_by_email,
    })),
    windows: { day: w("day"), week: w("week") },
    reasons: reasons.rows,
    networks: networks.rows.map((r) => ({ asn: r.asn, org: r.org, visitors: r.visitors, botVisitors: r.bot_visitors, views: r.views })),
    countries: countries.rows.map((r) => ({ country: r.country, visitors: r.visitors, botVisitors: r.bot_visitors })),
    sources: sources.rows.map((r) => ({ source: r.source, visitors: r.visitors, botVisitors: r.bot_visitors })),
    ads: ads.rows.map((r) => ({ ad: r.ad, visitors: r.visitors, botVisitors: r.bot_visitors })),
    recent: recentRows.map((r) => ({
      at: new Date(r.at).toISOString(),
      ip: r.ip,
      visitorId: r.visitor_id,
      country: r.country,
      asn: r.asn,
      org: r.as_org,
      reasons: r.reasons ?? [],
      verdict: r.verdict,
      path: r.path,
      source: r.source,
      ua: r.ua,
    })),
    daily: daily.rows,
    status: {
      ipdbVersion: ipdb.rows[0]?.version ?? null,
      ipdbRefreshedAt: ipdb.rows[0]?.refreshed_at ? new Date(ipdb.rows[0].refreshed_at).toISOString() : null,
      lastCheckAt: last.rows[0]?.last_at ? new Date(last.rows[0].last_at).toISOString() : null,
      checksLastHour: last.rows[0]?.last_hour ?? 0,
    },
  };
}
