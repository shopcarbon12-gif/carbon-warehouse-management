import { readFileSync } from "node:fs";
import pg from "pg";
const { Client } = pg;
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
const c = new Client({ connectionString: m[1].trim() });
await c.connect();
try {
  const r = await c.query(
    `SELECT id, name, network_address, status_online
       FROM devices
      WHERE id = 'cbbeffbd-6ba7-4965-beba-80e206327b9e'::uuid
         OR network_address = '192.168.1.69'
         OR name = 'POS'`
  );
  console.log("devices:", JSON.stringify(r.rows, null, 2));

  const t = await c.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND (table_name ILIKE '%wiznet%' OR table_name ILIKE '%discover%')`
  );
  console.log("wiznet-tables:", t.rows);

  const r2 = await c.query(
    `SELECT count(*) AS cdm_reads_for_pos
       FROM cdm_reads
      WHERE reader_id = 'cbbeffbd-6ba7-4965-beba-80e206327b9e'::uuid`
  );
  console.log("cdm_reads:", r2.rows[0]);
} finally {
  await c.end();
}
