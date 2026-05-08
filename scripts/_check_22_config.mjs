import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
const url = m[1].trim().replace(/^["']|["']$/g, "").replace(/@178\.156\.136\.112:\d+/, "@localhost:16543");
const pool = new Pool({ connectionString: url, ssl: false });

const r = await pool.query(`
  SELECT d.name, d.network_address,
         d.config->>'monsoon_driver' AS driver,
         d.config AS reader_config,
         a.name AS antenna_name, a.config AS antenna_config
    FROM devices d
    LEFT JOIN devices a ON a.parent_device_id = d.id AND a.device_type='antenna'
   WHERE d.network_address IN ('192.168.1.18','192.168.1.22')
   ORDER BY d.network_address`);
for (const row of r.rows) {
  console.log(`${row.name} (${row.network_address}): driver=${row.driver || "default"}`);
  console.log(`  reader.config = ${JSON.stringify(row.reader_config)}`);
  console.log(`  antenna ${row.antenna_name}: ${JSON.stringify(row.antenna_config)}`);
  console.log();
}
await pool.end();
