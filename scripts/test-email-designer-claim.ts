/**
 * CarbonWMS Email AI Designer — which turns the worker starts (throwaway Postgres, no OpenAI key):
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres npx tsx scripts/test-email-designer-claim.ts
 * Run scripts/test-email-layout.ts first (tables + migrations).
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
    (await pool.query<{ status: string; concept: string | null }>(`SELECT status, concept FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`, [sent.aiIds])).rows;
  const quiet = () => {};
  await runDesignTurns(pool, quiet);
  // Each direction is its own idea (owner, 2026-11-08): direction 1 starts 2 and 3 at once and every one
  // writes its own concept (each fails here at the concept step: no OpenAI key).
  assert.deepEqual((await st()).map((r) => [r.status, r.concept]), [["failed", "concept"], ["failed", "concept"], ["failed", "concept"]]);
  // A turn waiting for the owner's approval is never started by the worker.
  const r = await addOwnerMessage(pool, { designId: d.rows[0].id, text: "x", attachments: [], target: "both", mode: "fast", by: null });
  await pool.query(`UPDATE email_design_messages SET status = 'review' WHERE id = $1::uuid`, [r.aiId]);
  await runDesignTurns(pool, quiet);
  assert.equal((await pool.query<{ status: string }>(`SELECT status FROM email_design_messages WHERE id = $1::uuid`, [r.aiId])).rows[0].status, "review");
  console.log("ok  directions: all three start together, each with its own concept; review waits");
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
