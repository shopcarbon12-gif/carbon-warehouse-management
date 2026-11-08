/**
 * CarbonWMS Email brand media library — queries against a THROWAWAY Postgres
 * (never a real database):
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres npx tsx scripts/test-email-media-db.ts
 * Run scripts/test-email-db.ts first (it applies 0147/0148).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { STORE_MEDIA, mediaLibrary, mediaLines, mediaStatus } from "../lib/server/email/brand";
import { emailWorkPending } from "../lib/server/email/pending";

const url = process.env.TEST_DB ?? "";
if (!/127\.0\.0\.1:55499|localhost:55499/.test(url)) throw new Error("TEST_DB must point at the throwaway test Postgres on :55499");
const pool = new Pool({ connectionString: url });

(async () => {
  const sql = readFileSync("scripts/migrations/0149_email_brand_media.sql", "utf8");
  await pool.query(sql);
  await pool.query(sql); // re-runnable
  await pool.query(`DELETE FROM email_media`);
  await pool.query(`UPDATE email_media_sync SET listed_at = now() WHERE id = 1`);
  await pool.query(`INSERT INTO email_media (file_gid,url,width,height,file_created,described_at,kind,usable,description) VALUES
    ('g1','https://x/a.png?v=1',1942,809,now(),now(),'campaign',true,'Two models in denim at sunset'),
    ('g2','https://x/b.png',900,1200,now(),now(),'text',false,'A notice'),
    ('g3','https://x/c.png',1024,1536,now(),NULL,NULL,NULL,NULL)`);

  const lib = await mediaLibrary(pool);
  assert.deepEqual(lib.map((m) => m.ref), ["S1", "S2", "M1"], "store photos pinned first, only usable + described pictures");
  assert.match(mediaLines(lib), /M1 \| campaign \| wide banner 1942x809 \| Two models/);
  const st = await mediaStatus(pool);
  assert.deepEqual([st.total, st.described, st.usable], [3, 2, 1 + STORE_MEDIA.length]);

  // An undescribed picture makes the worker call the tick (for a tenant that uses Email).
  const hasTenant = (await pool.query(`SELECT 1 FROM email_designs LIMIT 1`)).rowCount;
  const pend = await emailWorkPending(pool);
  if (hasTenant) assert.ok(pend.length > 0, "media work pending");
  await pool.query(`UPDATE email_media SET described_at = now() WHERE described_at IS NULL`);
  console.log("ok  brand media library", { pendingWhileDescribing: pend.length });
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
