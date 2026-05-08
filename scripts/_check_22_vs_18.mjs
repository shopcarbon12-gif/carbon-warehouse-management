import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
const url = m[1].trim().replace(/^["']|["']$/g, "").replace(/@178\.156\.136\.112:\d+/, "@localhost:16543");
const pool = new Pool({ connectionString: url, ssl: false });

const dev = await pool.query(`
  SELECT id::text, name, network_address, status_online,
         bridge_seen_at::text,
         (SELECT count(*) FROM devices WHERE parent_device_id = d.id AND device_type='antenna')::int AS antenna_count
    FROM devices d
   WHERE network_address IN ('192.168.1.18','192.168.1.22')
   ORDER BY network_address`);
for (const r of dev.rows) {
  console.log(`${r.name} (${r.network_address}) — ${r.antenna_count} antennas — online=${r.status_online}`);
  console.log(`  id=${r.id}`);
}
console.log();

// Hourly reads per reader, last 12 hours
const hist = await pool.query(`
  SELECT d.network_address AS ip,
         date_trunc('hour', r.ingested_at) AS h,
         count(*)::text AS reads
    FROM cdm_reads r
    INNER JOIN devices d ON d.id = r.reader_id
   WHERE d.network_address IN ('192.168.1.18','192.168.1.22')
     AND r.ingested_at > now() - interval '12 hours'
   GROUP BY 1, 2 ORDER BY 2 DESC, 1`);
console.log("Hour                  IP             Reads");
for (const r of hist.rows) {
  console.log(`${new Date(r.h).toISOString().slice(0,16)}  ${r.ip.padEnd(13)}  ${r.reads}`);
}
console.log();

// Per-antenna reads in last hour
const ant = await pool.query(`
  SELECT d.network_address AS ip, a.name AS antenna,
         a.last_read_at::text,
         count(r.id)::text AS reads_last_1h
    FROM devices d
    INNER JOIN devices a ON a.parent_device_id = d.id AND a.device_type='antenna'
    LEFT JOIN cdm_reads r ON r.reader_id = d.id AND r.antenna_id = a.id AND r.ingested_at > now() - interval '1 hour'
   WHERE d.network_address IN ('192.168.1.18','192.168.1.22')
   GROUP BY 1,2,3 ORDER BY 1,2`);
console.log("IP            Antenna                Last read at           Reads last 1h");
for (const r of ant.rows) {
  const ago = r.last_read_at ? Math.round((Date.now() - new Date(r.last_read_at).getTime())/1000) + "s" : "—";
  console.log(`${r.ip.padEnd(13)} ${r.antenna.padEnd(22)} ${(r.last_read_at||"never").padEnd(22)}  ${r.reads_last_1h.padStart(8)}  (${ago} ago)`);
}
await pool.end();
