import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
if (!m) { console.error("no DATABASE_URL"); process.exit(1); }
// Tunnel localhost:16543 → 152.53.210.171:3000 via .219
const raw = m[1].trim().replace(/^["']|["']$/g, "");
// Print host:port so we can see what we're connecting to (no creds).
const u = new URL(raw);
console.log(`source DATABASE_URL host:port = ${u.host}, db=${u.pathname}`);
// Stale .env.coolify.local has :3000; Coolify API confirms public port = 2040.
// Tunnel localhost:16543 → 152.53.210.171:2040 via .219.
const url = raw.replace(/@178\.156\.136\.112:\d+/, "@localhost:16543");
const pool = new Pool({ connectionString: url, ssl: false });
const r = await pool.query(`
  SELECT name, network_address, mac_address,
         status_online,
         bridge_seen_at,
         CASE WHEN status_online THEN 'online'
              WHEN bridge_seen_at IS NOT NULL AND now() - bridge_seen_at < interval '3 minutes' THEN 'reachable'
              ELSE 'offline' END AS predicted_state
    FROM devices
   WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
   ORDER BY network_address
`);
for (const row of r.rows) {
  const ago = row.bridge_seen_at ? Math.round((Date.now() - new Date(row.bridge_seen_at).getTime())/1000)+'s' : '-';
  console.log(`${(row.name||'').padEnd(22)} ip=${(row.network_address||'').padEnd(15)} mac=${(row.mac_address||'NONE').padEnd(14)} online=${String(row.status_online).padEnd(5)} bridge_seen=${ago.padStart(6)} → ${row.predicted_state}`);
}
await pool.end();
