/** CarbonWMS Email — what the worker checks before calling the web app's tick (no SDKs loaded here). */
import type { Pool } from "pg";

/** Anything for the tick to do? (the worker only calls the web app when so). */
export async function emailWorkPending(pool: Pool): Promise<{ tenant_id: string; requested_by: string | null }[]> {
  const r = await pool.query<{ tenant_id: string; requested_by: string | null }>(
    `SELECT tenant_id::text, max(created_by) AS requested_by FROM (
       SELECT tenant_id, created_by FROM email_campaigns WHERE status IN ('scheduled','sending') AND send_at <= now() + interval '1 minute'
       UNION ALL
       SELECT d.tenant_id, d.created_by FROM email_design_messages m JOIN email_designs d ON d.id = m.design_id WHERE m.status IN ('queued','planning','generating','approved','approved-planning')
       UNION ALL
       SELECT tenant_id, created_by FROM email_designs WHERE status = 'converting' OR check_status = 'queued'
          OR (status = 'checking' AND updated_at < now() - interval '30 minutes')
       UNION ALL
       -- brand media library (lib/server/email/brand.ts): new Shopify files once a day, then describe what is new
       SELECT t.tenant_id, NULL FROM (SELECT DISTINCT tenant_id FROM email_designs) t
        WHERE EXISTS (SELECT 1 FROM email_media_sync WHERE id = 1 AND (listed_at IS NULL OR listed_at < now() - interval '1 day'))
           OR EXISTS (SELECT 1 FROM email_media WHERE described_at IS NULL)
       UNION ALL
       SELECT tenant_id, created_by FROM email_campaigns WHERE offer IS NOT NULL AND status IN ('sending','sent','paused','cancelled') AND started_at IS NOT NULL
          AND (results_at IS NULL OR results_at < now() - interval '3 hours') AND (offer->>'endsAt')::timestamptz > now() - interval '3 days'
       UNION ALL
       -- automatic emails (lib/server/email/flows.ts): every minute while a flow is live
       SELECT tenant_id, created_by FROM email_flows WHERE status = 'live' AND archived_at IS NULL
       UNION ALL
       -- the order history (flows' "stop if they ordered", win-back, segments): every 5 minutes
       SELECT s.tenant_id, NULL FROM email_settings s
        WHERE NOT EXISTS (SELECT 1 FROM email_flow_state f WHERE f.tenant_id = s.tenant_id AND f.key = 'polled_at' AND f.value::timestamptz > now() - interval '5 minutes')
     ) x GROUP BY tenant_id`,
  );
  return r.rows;
}
