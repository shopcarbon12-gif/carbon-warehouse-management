/**
 * CarbonWMS Email AI Designer — which turns the worker starts (throwaway Postgres, no OpenAI key):
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres OPENAI_API_KEY= npx tsx scripts/test-email-designer-claim.ts
 * Run scripts/test-email-layout.ts first (tables + 0151).
 */
import assert from "node:assert/strict";
import { Pool } from "pg";
import { addOwnerMessage, runDesignTurns } from "../lib/server/email/designer";

const url = process.env.TEST_DB ?? "";
if (!/127\.0\.0\.1:55499|localhost:55499/.test(url)) throw new Error("TEST_DB must point at the throwaway test Postgres on :55499");
delete process.env.OPENAI_API_KEY;
const pool = new Pool({ connectionString: url });
const T = "00000000-0000-0000-0000-000000000001";

(async () => {
  const d = await pool.query<{ id: string }>(`INSERT INTO email_designs (tenant_id, title) VALUES ($1, 'Claim test') RETURNING id::text`, [T]);
  const sent = await addOwnerMessage(pool, { designId: d.rows[0].id, text: "AW", attachments: [], target: "both", mode: "fast", by: null, directions: true });
  const st = async () =>
    (await pool.query<{ variant_no: number; status: string }>(`SELECT variant_no, status FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`, [sent.aiIds])).rows.map((r) => r.status);
  const quiet = () => {};
  await runDesignTurns(pool, quiet);
  // Direction 1 was started (and failed here: no OpenAI key); 2 and 3 wait for direction 1's items.
  assert.deepEqual(await st(), ["failed", "queued", "queued"]);
  // Direction 1 approved with items → 2 and 3 can start (they share the items), 1 is drawn.
  await pool.query(`UPDATE email_design_messages SET status = 'approved', products = '[]', media = '[]', desktop_prompt = NULL WHERE id = $1::uuid`, [sent.aiIds[0]]);
  await pool.query(`UPDATE email_design_messages SET products = '[]', media = '[]' WHERE id = ANY($1::uuid[])`, [sent.aiIds.slice(1)]);
  await runDesignTurns(pool, quiet);
  assert.deepEqual(await st(), ["failed", "failed", "failed"], "all three were started");
  // A turn waiting for review is never started by the worker.
  const r = await addOwnerMessage(pool, { designId: d.rows[0].id, text: "x", attachments: [], target: "both", mode: "fast", by: null });
  await pool.query(`UPDATE email_design_messages SET status = 'review' WHERE id = $1::uuid`, [r.aiId]);
  await runDesignTurns(pool, quiet);
  assert.equal((await pool.query<{ status: string }>(`SELECT status FROM email_design_messages WHERE id = $1::uuid`, [r.aiId])).rows[0].status, "review");
  console.log("ok  worker claims: direction 1 first, 2-3 after its items, review waits");
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
