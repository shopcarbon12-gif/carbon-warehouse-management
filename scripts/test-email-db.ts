/**
 * CarbonWMS Email — database test against a THROWAWAY Postgres (never prod):
 *   docker run -d --rm --name carbon-email-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55499:5432 postgres:16-alpine
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres npx tsx scripts/test-email-db.ts
 * Applies only migration 0147 and checks the contact list, audiences, the
 * approval snapshot, SES events, unsubscribes and campaign states.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { applyEvent, campaignStats, setCampaignState, snapshotRecipients } from "../lib/server/email/campaigns";
import { audienceCount, contactSummary, unsubscribeContact } from "../lib/server/email/contacts";
import { addOwnerMessage, stopTurn } from "../lib/server/email/designer";
import { emailWorkPending } from "../lib/server/email/pending";

const url = process.env.TEST_DB ?? "";
if (!/127\.0\.0\.1:55499|localhost:55499/.test(url)) throw new Error("TEST_DB must point at the throwaway test Postgres on :55499");
const T = "00000000-0000-0000-0000-000000000001";

async function main() {
  const pool = new Pool({ connectionString: url });
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  // Idempotent: the migrations run again on every deploy.
  for (let pass = 0; pass < 2; pass++)
    for (const f of ["0147_email_campaigns.sql", "0148_email_design_products.sql", "0149_email_brand_media.sql", "0150_email_layout_engine.sql"]) await pool.query(readFileSync(`scripts/migrations/${f}`, "utf8"));
  console.log("ok  migrations apply twice");

  const add = (email: string, o: Record<string, unknown> = {}) =>
    pool.query(
      `INSERT INTO email_contacts (tenant_id, email, first_name, shopify_marketing, customer_since, unsub_token, excluded_reason, unsubscribed_at, bounced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [T, email, o.first ?? null, o.marketing ?? null, o.since ?? null, `tok-${email}`, o.excluded ?? null, o.unsub ?? null, o.bounced ?? null],
    );
  await add("old@gmail.com", { first: "Old", since: "2021-05-01" });
  await add("new@gmail.com", { first: "New", since: "2026-02-01" });
  await add("sub@gmail.com", { first: "Sub", since: "2022-01-01", marketing: "SUBSCRIBED" });
  await add("fake@example.com", { excluded: "fake" });
  await add("gone@gmail.com", { unsub: new Date() });
  await add("bounce@gmail.com", { bounced: new Date() });

  assert.equal(await audienceCount(pool, T, { who: "all" }), 3);
  assert.equal(await audienceCount(pool, T, { who: "subscribed" }), 1);
  assert.equal(await audienceCount(pool, T, { who: "all", sinceYear: 2023 }), 1);
  assert.equal(await audienceCount(pool, T, { who: "all", beforeYear: 2023 }), 2);
  assert.equal(await audienceCount(pool, T, { who: "all", emails: ["new@gmail.com", "gone@gmail.com"] }), 1);
  const sum = await contactSummary(pool, T);
  assert.equal(sum.mailable, 3);
  assert.equal(sum.excluded.fake, 1);
  assert.equal(sum.unsubscribed, 1);
  assert.equal(sum.bounced, 1);
  console.log("ok  audiences never include excluded / unsubscribed / bounced");

  const camp = await pool.query<{ id: string }>(`INSERT INTO email_campaigns (tenant_id, name, subject, audience, status) VALUES ($1, 'Test', 'Hi', '{"who":"all"}', 'scheduled') RETURNING id`, [T]);
  const cid = camp.rows[0].id;
  assert.equal(await snapshotRecipients(pool, T, cid, { who: "all" }), 3);
  assert.equal(await snapshotRecipients(pool, T, cid, { who: "all" }), 0, "a second snapshot adds nobody twice");
  const order = await pool.query<{ email: string }>(`SELECT email FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY sort_key`, [cid]);
  assert.deepEqual(order.rows.map((r) => r.email), ["sub@gmail.com", "new@gmail.com", "old@gmail.com"]);
  console.log("ok  approval snapshot: subscribed first, then newest customers");

  // Pretend all three were sent.
  await pool.query(`UPDATE email_campaign_recipients SET status = 'sent', sent_at = now() - interval '1 minute', message_id = 'm-' || email WHERE campaign_id = $1`, [cid]);
  await applyEvent(pool, "sns-1", { eventType: "Delivery", mail: { messageId: "m-new@gmail.com" }, delivery: { timestamp: new Date().toISOString() } });
  await applyEvent(pool, "sns-1", { eventType: "Delivery", mail: { messageId: "m-new@gmail.com" } }); // duplicate SNS delivery
  await applyEvent(pool, "sns-2", { eventType: "Click", mail: { messageId: "m-new@gmail.com" }, click: { timestamp: new Date().toISOString(), link: "x" } });
  await applyEvent(pool, "sns-3", { eventType: "Bounce", mail: { messageId: "m-old@gmail.com" }, bounce: { bounceType: "Transient" } });
  let st = await campaignStats(pool, cid);
  assert.equal(st.delivered, 1);
  assert.equal(st.clicked, 1);
  assert.equal(st.opened, 1, "a click counts as an open");
  assert.equal(st.bounced, 0, "a soft bounce is not a bounce");
  await applyEvent(pool, "sns-4", { eventType: "Bounce", mail: { messageId: "m-old@gmail.com" }, bounce: { bounceType: "Permanent" } });
  await applyEvent(pool, "sns-5", { eventType: "Complaint", mail: { messageId: "m-sub@gmail.com" }, complaint: {} });
  st = await campaignStats(pool, cid);
  assert.equal(st.bounced, 1);
  assert.equal(st.complained, 1);
  assert.equal(st.unsubscribed, 1, "a spam complaint also unsubscribes");
  assert.equal(await audienceCount(pool, T, { who: "all" }), 1, "bounced and complained people drop out of every audience");
  const ev = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM email_events`);
  assert.equal(Number(ev.rows[0].n), 5);
  console.log("ok  SES events: idempotent, soft vs hard bounce, complaint suppresses");

  const u = await unsubscribeContact(pool, "tok-new@gmail.com", "one_click");
  assert.equal(u.ok, true);
  assert.equal((await unsubscribeContact(pool, "nope", "link")).ok, false);
  assert.equal(await audienceCount(pool, T, { who: "all" }), 0);
  console.log("ok  unsubscribe by token");

  await setCampaignState(pool, T, cid, "pause");
  await assert.rejects(setCampaignState(pool, T, cid, "pause"));
  await setCampaignState(pool, T, cid, "resume");
  let row = await pool.query<{ status: string }>(`SELECT status FROM email_campaigns WHERE id = $1`, [cid]);
  assert.equal(row.rows[0].status, "scheduled", "resume before start goes back to scheduled");
  await pool.query(`UPDATE email_campaign_recipients SET status = 'queued' WHERE campaign_id = $1 AND email = 'old@gmail.com'`, [cid]);
  await setCampaignState(pool, T, cid, "cancel");
  row = await pool.query(`SELECT status FROM email_campaigns WHERE id = $1`, [cid]);
  assert.equal(row.rows[0].status, "cancelled");
  st = await campaignStats(pool, cid);
  assert.equal(st.skipped, 1);
  await assert.rejects(setCampaignState(pool, T, cid, "resume"));
  console.log("ok  pause / resume / cancel");

  const d = await pool.query<{ id: string }>(`INSERT INTO email_designs (tenant_id, created_by) VALUES ($1, 'owner@x.com') RETURNING id`, [T]);
  const did = d.rows[0].id;
  const turn = await addOwnerMessage(pool, { designId: did, text: "A win-back email", attachments: [], target: "mobile", mode: "batch", by: "owner@x.com" });
  const ai = await pool.query<{ target: string; status: string; role: string }>(`SELECT target, status, role FROM email_design_messages WHERE id = $1`, [turn.aiId]);
  assert.deepEqual(ai.rows[0], { target: "both", status: "queued", role: "ai" }, "the first turn always draws both views");
  await assert.rejects(addOwnerMessage(pool, { designId: did, text: "again", attachments: [], target: "both", mode: "fast", by: null }), /still working/);
  const pending = await emailWorkPending(pool);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requested_by, "owner@x.com");
  assert.equal(await stopTurn(pool, did), true);
  // Finish a fake first turn, then a mobile-only turn keeps "mobile".
  await pool.query(`UPDATE email_design_messages SET status = 'done', desktop_path = 'd.png', mobile_path = 'm.png' WHERE id = $1`, [turn.aiId]);
  const t2 = await addOwnerMessage(pool, { designId: did, text: "bigger button on the phone", attachments: [], target: "mobile", mode: "fast", by: null });
  const ai2 = await pool.query<{ target: string }>(`SELECT target FROM email_design_messages WHERE id = $1`, [t2.aiId]);
  assert.equal(ai2.rows[0].target, "mobile");
  console.log("ok  AI Designer: first turn both, busy guard, stop, per-view turns");

  await pool.end();
  console.log("\nall database checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
