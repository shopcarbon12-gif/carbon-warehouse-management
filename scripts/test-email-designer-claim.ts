/**
 * CarbonWMS Email AI Designer — which turns the worker starts (throwaway Postgres, no OpenAI key):
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres npx tsx scripts/test-email-designer-claim.ts
 * Run scripts/test-email-layout.ts first (tables + migrations up to 0152).
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
    (await pool.query<{ status: string }>(`SELECT status FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`, [sent.aiIds])).rows.map((r) => r.status);
  const quiet = () => {};
  await runDesignTurns(pool, quiet);
  // Direction 1 started (step 1, the concept — it fails here: no OpenAI key); 2 and 3 wait for its concept and photos.
  assert.deepEqual(await st(), ["failed", "queued", "queued"]);
  const step = (await pool.query<{ concept: string | null }>(`SELECT concept FROM email_design_messages WHERE id = $1::uuid`, [sent.aiIds[0]])).rows[0].concept;
  assert.equal(step, "concept", "direction 1 was at the concept step");
  // Directions 2–3 are only started by direction 1's run; the worker picks them up only as a fallback
  // (direction 1 finished or gone for 3 minutes).
  await runDesignTurns(pool, quiet);
  assert.deepEqual(await st(), ["failed", "queued", "queued"], "not yet: direction 1 failed just now");
  await pool.query(`UPDATE email_design_messages SET step_at = now() - interval '5 minutes' WHERE id = $1::uuid`, [sent.aiIds[0]]);
  await runDesignTurns(pool, quiet);
  assert.deepEqual(await st(), ["failed", "failed", "failed"], "fallback started 2 and 3");
  // A turn waiting for the owner's approval is never started by the worker.
  const r = await addOwnerMessage(pool, { designId: d.rows[0].id, text: "x", attachments: [], target: "both", mode: "fast", by: null });
  await pool.query(`UPDATE email_design_messages SET status = 'review' WHERE id = $1::uuid`, [r.aiId]);
  await runDesignTurns(pool, quiet);
  assert.equal((await pool.query<{ status: string }>(`SELECT status FROM email_design_messages WHERE id = $1::uuid`, [r.aiId])).rows[0].status, "review");
  console.log("ok  directions: 1 makes the concept + photos first, 2–3 follow (fallback after 3 min); review waits");
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
