import { readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
if (!m) throw new Error("DATABASE_URL missing from .env.coolify.local");

const c = new Client({ connectionString: m[1].trim() });
await c.connect();
const r = await c.query(`
  SELECT d.network_address AS ip, d.name,
         d.config->>'monsoon_driver' AS driver,
         d.config->>'transmit_power_dbm' AS pow,
         d.config->>'monsoon_serial_port' AS port,
         (SELECT COUNT(*) FROM antenna_profiles ap WHERE ap.device_id=d.id AND ap.enabled=true) AS enabled_ants,
         (SELECT string_agg(ap.antenna_number::text||'='||COALESCE(ap.transmit_power_dbm::text,'null'),',' ORDER BY ap.antenna_number)
            FROM antenna_profiles ap WHERE ap.device_id=d.id AND ap.enabled=true) AS ant_powers
  FROM devices d
  WHERE d.network_address IN ('192.168.1.9','192.168.1.225','192.168.1.15','192.168.1.85','192.168.1.81','192.168.1.77','192.168.1.78','192.168.1.79','192.168.1.82','192.168.1.84','192.168.1.16')
  ORDER BY d.network_address;
`);
console.table(r.rows);
await c.end();
