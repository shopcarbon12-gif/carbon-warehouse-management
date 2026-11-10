/**
 * CarbonWMS Email — Reports (phase 5): what every email did, campaigns and automatic emails together.
 * An order counts for an email when the person ordered (online or in the store) within 5 days of
 * receiving it (Klaviyo's default window); each order counts once, for the latest email before it.
 */
import type { Pool } from "pg";

export type ReportRow = { kind: "campaign" | "flow"; id: string; name: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsub: number; orders: number; revenue: number; when: string | null };
export type Report = {
  days: number;
  totals: Omit<ReportRow, "kind" | "id" | "name" | "when">;
  weeks: { week: string; sent: number; revenue: number; orders: number }[];
  rows: ReportRow[];
};

export async function emailReport(pool: Pool, tenantId: string, days: number): Promise<Report> {
  const d = Math.max(1, Math.min(365, Math.trunc(days)));
  // Every email that went out in the window, from campaigns and flows, with who and when.
  const sends = `
    SELECT 'campaign'::text AS kind, r.campaign_id::text AS src, r.email, r.contact_id, r.sent_at, r.delivered_at, r.opened_at, r.clicked_at, r.bounced_at, r.complained_at
      FROM email_campaign_recipients r JOIN email_campaigns c ON c.id = r.campaign_id
     WHERE c.tenant_id = $1::uuid AND r.status = 'sent' AND r.sent_at > now() - make_interval(days => $2::int)
    UNION ALL
    SELECT 'flow', s.flow_id::text, s.email, s.contact_id, s.sent_at, s.delivered_at, s.opened_at, s.clicked_at, s.bounced_at, s.complained_at
      FROM email_flow_sends s JOIN email_flows f ON f.id = s.flow_id
     WHERE f.tenant_id = $1::uuid AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => $2::int)`;
  // Each order once, credited to the latest email that reached the person in the 5 days before it.
  const credited = `
    SELECT DISTINCT ON (o.source, o.order_id) o.order_id, o.total, o.processed_at, x.kind, x.src
      FROM email_orders_seen o JOIN (${sends}) x ON x.email = o.email AND o.processed_at > x.sent_at AND o.processed_at < x.sent_at + interval '5 days'
     WHERE o.tenant_id = $1::uuid
     ORDER BY o.source, o.order_id, x.sent_at DESC`;
  const per = await pool.query<{ kind: "campaign" | "flow"; src: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; first: Date | null }>(
    `SELECT kind, src, count(*)::int AS sent, count(delivered_at)::int AS delivered, count(opened_at)::int AS opened, count(clicked_at)::int AS clicked,
            count(bounced_at)::int AS bounced, count(complained_at)::int AS complained, min(sent_at) AS first
       FROM (${sends}) x GROUP BY kind, src`,
    [tenantId, d],
  );
  const orders = await pool.query<{ kind: string; src: string; orders: number; revenue: string }>(
    `SELECT kind, src, count(*)::int AS orders, COALESCE(sum(total), 0)::text AS revenue FROM (${credited}) y GROUP BY kind, src`,
    [tenantId, d],
  );
  const unsub = await pool.query<{ kind: string; src: string; n: number }>(
    `SELECT x.kind, x.src, count(DISTINCT x.email)::int AS n FROM (${sends}) x JOIN email_contacts c ON c.id = x.contact_id
      WHERE c.unsubscribed_at > x.sent_at AND c.unsubscribed_at < x.sent_at + interval '3 days' GROUP BY x.kind, x.src`,
    [tenantId, d],
  );
  const names = await pool.query<{ kind: string; id: string; name: string }>(
    `SELECT 'campaign' AS kind, id::text, name FROM email_campaigns WHERE tenant_id = $1::uuid UNION ALL SELECT 'flow', id::text, name FROM email_flows WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const nameOf = new Map(names.rows.map((x) => [`${x.kind}:${x.id}`, x.name]));
  const ordOf = new Map(orders.rows.map((x) => [`${x.kind}:${x.src}`, x]));
  const unsOf = new Map(unsub.rows.map((x) => [`${x.kind}:${x.src}`, x.n]));
  const rows: ReportRow[] = per.rows
    .map((x) => {
      const k = `${x.kind}:${x.src}`;
      return {
        kind: x.kind,
        id: x.src,
        name: nameOf.get(k) ?? "(deleted)",
        sent: x.sent,
        delivered: x.delivered,
        opened: x.opened,
        clicked: x.clicked,
        bounced: x.bounced,
        complained: x.complained,
        unsub: unsOf.get(k) ?? 0,
        orders: ordOf.get(k)?.orders ?? 0,
        revenue: Number(ordOf.get(k)?.revenue ?? 0),
        when: x.first ? x.first.toISOString() : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.sent - a.sent);
  const totals = rows.reduce(
    (t, r) => ({
      sent: t.sent + r.sent,
      delivered: t.delivered + r.delivered,
      opened: t.opened + r.opened,
      clicked: t.clicked + r.clicked,
      bounced: t.bounced + r.bounced,
      complained: t.complained + r.complained,
      unsub: t.unsub + r.unsub,
      orders: t.orders + r.orders,
      revenue: t.revenue + r.revenue,
    }),
    { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsub: 0, orders: 0, revenue: 0 },
  );
  const weeks = await pool.query<{ week: Date; sent: number; orders: number; revenue: string }>(
    `WITH s AS (SELECT date_trunc('week', sent_at AT TIME ZONE 'America/New_York') AS week, count(*)::int AS sent FROM (${sends}) x GROUP BY 1),
          o AS (SELECT date_trunc('week', processed_at AT TIME ZONE 'America/New_York') AS week, count(*)::int AS orders, sum(total) AS revenue FROM (${credited}) y GROUP BY 1)
     SELECT COALESCE(s.week, o.week) AS week, COALESCE(s.sent, 0) AS sent, COALESCE(o.orders, 0) AS orders, COALESCE(o.revenue, 0)::text AS revenue
       FROM s FULL JOIN o ON o.week = s.week ORDER BY 1`,
    [tenantId, d],
  );
  return { days: d, totals, rows, weeks: weeks.rows.map((w) => ({ week: w.week.toISOString().slice(0, 10), sent: w.sent, orders: w.orders, revenue: Number(w.revenue) })) };
}
