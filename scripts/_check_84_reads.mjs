import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
const raw = m[1].trim().replace(/^["']|["']$/g, "");
const url = raw.replace(/@178\.156\.136\.112:\d+/, "@localhost:16543");
const pool = new Pool({ connectionString: url, ssl: false });
// Find the .84 device
const dev = await pool.query(`
  SELECT id::text, name, status_online, bridge_seen_at::text
    FROM devices
   WHERE network_address = '192.168.1.84'
     AND device_type IN ('fixed_reader','transaction_reader','door_reader')
   LIMIT 1`);
const d = dev.rows[0];
console.log(`Reader: ${d.name} (id=${d.id})`);
console.log();
// Histogram of reads ingested per hour for the last 24h
const hist = await pool.query(`
  SELECT date_trunc('hour', ingested_at) AS h, count(*)::text AS reads
    FROM cdm_reads
   WHERE reader_id = $1::uuid
     AND ingested_at > now() - interval '24 hours'
   GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
  [d.id]);
console.log("Hour                    Reads");
for (const row of hist.rows) {
  console.log(`${new Date(row.h).toISOString().slice(0,16)}    ${row.reads}`);
}
console.log();
// Most recent read overall
const last = await pool.query(`
  SELECT max(ingested_at)::text AS last_read FROM cdm_reads WHERE reader_id = $1::uuid`,
  [d.id]);
console.log(`Last read ever from .84: ${last.rows[0].last_read || "(none)"}`);
await pool.end();
