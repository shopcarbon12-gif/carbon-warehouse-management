// One-shot: default-pause all reader devices that are currently un-paused.
// Run from dev workstation with the prod DB tunnel up:
//   ssh -fNT -L 16543:152.53.210.171:2040 shopcarbon@192.168.1.219
//   node scripts/_default_pause_readers.mjs
//
// Writes scan_paused_at = now() and scan_paused_by = NULL (system action,
// not user-initiated) for every fixed_reader / transaction_reader / door_reader
// where scan_paused_at is currently NULL. Reversible via Hardware Config UI
// per-reader Resume button.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const env = readFileSync(".env.coolify.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
const url = m[1].trim().replace(/^["']|["']$/g, "").replace(/@178\.156\.136\.112:\d+/, "@localhost:16543");
const pool = new Pool({ connectionString: url, ssl: false });

const before = await pool.query(`
  SELECT count(*)::int AS unpaused
    FROM devices
   WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
     AND scan_paused_at IS NULL
`);
console.log(`Currently unpaused readers: ${before.rows[0].unpaused}`);

const r = await pool.query(`
  UPDATE devices
     SET scan_paused_at = now(),
         updated_at = now()
   WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
     AND scan_paused_at IS NULL
  RETURNING id::text, name, network_address
`);
console.log(`Default-paused ${r.rowCount} readers:`);
for (const row of r.rows) {
  console.log(`  ${(row.name || '').padEnd(20)} ${row.network_address || '—'}`);
}
await pool.end();
console.log("Done. Agent will reconcile within 60s; supervisor will kill children for paused readers next reconcile tick.");
