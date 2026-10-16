// Owner, 2026-10-16: "change all these items statuses to unknown immediately"
// — 8 phantom LIVE tags: each number was created by a single read on
// 2026-10-13 (3 by the Aisle 3-4 fixed readers, 5 by the C-029 Add-On on the
// handhelds), never encoded or printed by Carbon, never read before or since
// (5 Cloud + Geiger passes looked for them). Rhea Jacket WHITE S: 4 on the
// shelf vs 5 in the WMS. As UNKNOWN they stop counting in stock and on Shopify; a real
// tag comes back LIVE by itself when it is read again (lib/server/epc-ingress).
// Each EPC is re-checked first: still LIVE and not read since the hunt began.
// Writes the full rows to docs/rfid/evidence first and a STATUS_CHANGE audit
// row per tag.
//
//   DATABASE_URL=… node scripts/oneoffs/unfound-epcs-to-unknown-2026-10-16.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/unfound-epcs-to-unknown-2026-10-16.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/phantom-epcs-to-unknown-backup-2026-10-16.json');
const HUNT_START = new Date('2026-10-15T00:00:00Z');

const EPCS = [
  'F0A0B30E4F9BB7E000012502', // Rhea Jacket WHITE S — shelf count 4, WMS 5 (confirmed)
  'F0A0B30E4F9C8440000191A0', // Apology Hoodie BLACK L
  'F0A0B30E4F9BBF40000126AD', // Marlee Crop Top BLACK 38
  'F0A0B30E4F9B9D7000002212', // Finn Jeans BLUE 30
  'F0A0B30E4F9CB3100001A196', // Carbon Classic T WHITE XXXL
  'F0A0B30E4F9C28B000013029', // Bracelet Z BLACK OS
  'F0A0B30E4F9D0810000186FB', // Russell Jacket BLACK S
  'F0A0B30E4F9C760000018C09', // Men's Boxer Brief 3-Pack BLACK XXL
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT to_jsonb(i) AS item, l.tenant_id::text AS tenant_id, m.description AS product, c.color_code AS color, c.size
       FROM items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN custom_skus c ON c.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = c.matrix_id
      WHERE i.epc = ANY($1::text[])
      ORDER BY i.epc
      FOR UPDATE OF i`,
    [EPCS],
  );
  const problems = [];
  const byEpc = new Map(rows.map((r) => [r.item.epc, r]));
  for (const epc of EPCS) {
    const r = byEpc.get(epc);
    if (!r) { problems.push(`${epc}: no item row`); continue; }
    const it = r.item;
    if (it.status !== 'in-stock') problems.push(`${epc}: status is ${it.status}, not LIVE`);
    if (it.last_seen_at && new Date(it.last_seen_at) >= HUNT_START) problems.push(`${epc}: read ${it.last_seen_at}`);
    if (!(new Date(it.created_at) >= new Date('2026-10-13T00:00:00Z') && new Date(it.created_at) < new Date('2026-10-14T00:00:00Z'))) problems.push(`${epc}: created ${it.created_at}, not on Oct 13`);
    console.log(`${epc}  ${r.product} ${r.color} ${r.size}  ${it.status}  last read ${it.last_seen_at ?? 'never'}`);
  }
  if (problems.length) throw new Error(`stopped, nothing changed:\n  ${problems.join('\n  ')}`);
  if (!WRITE) {
    await client.query('ROLLBACK');
    console.log('DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 1));
    const ids = rows.map((r) => r.item.id);
    const up = await client.query(`UPDATE items SET status = 'unknown' WHERE id = ANY($1::uuid[]) AND status = 'in-stock'`, [ids]);
    if (up.rowCount !== ids.length) throw new Error(`expected ${ids.length} updates, got ${up.rowCount}`);
    for (const r of rows) {
      await client.query(
        `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
         VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'in-stock', 'unknown', $3, NULL, NULL, NULL)`,
        [r.tenant_id, r.item.epc, 'phantom: first and only read 2026-10-13, never read again; Rhea S shelf count confirmed (owner 2026-10-16)'],
      );
    }
    await client.query('COMMIT');
    console.log(`set ${up.rowCount} to unknown; backup ${path.relative(process.cwd(), BACKUP)}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
