import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
const url = m[1].trim().replace(/^["']|["']$/g, "").replace(/@178\.156\.136\.112:\d+/, "@localhost:16543");
const pool = new Pool({ connectionString: url, ssl: false });
const r = await pool.query(`
  SELECT name, network_address, scan_paused_at::text,
         CASE WHEN scan_paused_at IS NULL THEN 'unpaused' ELSE 'paused' END AS state
    FROM devices
   WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
   ORDER BY network_address
`);
for (const row of r.rows) {
  console.log(`${(row.name||'').padEnd(20)} ${(row.network_address||'').padEnd(15)} ${row.state.padEnd(10)} paused_at=${row.scan_paused_at || '(null)'}`);
}
await pool.end();
