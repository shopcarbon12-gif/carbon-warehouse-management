// 9 LIVE tag numbers that the 2026-10-15 Bulk Geiger hunt (desk readers + two
// handheld Cloud + Geiger passes over the 176-EPC list) could not find, and that
// cannot be a garment's working tag → UNKNOWN (owner, 2026-10-15):
//   - 8 never read by any reader since the row was created (7 are the new number
//     of a re-encode logged 'ok'; …A574 has no encode at all);
//   - 1 came in through a transfer with a serial no Carbon encoder issues
//     (2,147,586,585 — a damaged chip's misread).
// As UNKNOWN they stop counting in stock and on Shopify; a real tag comes back
// LIVE by itself when it is read again (lib/server/epc-ingress).
// Each EPC is re-checked before it changes: still LIVE and its reason still true
// (never-read ones still never read; the misread one not read since 2026-09-26).
// Writes the full rows to docs/rfid/evidence first and a STATUS_CHANGE audit row
// per tag.
//
//   DATABASE_URL=… node scripts/oneoffs/unfindable-epcs-to-unknown-2026-10-15.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/unfindable-epcs-to-unknown-2026-10-15.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/unfindable-epcs-backup-2026-10-15.json');
const ISSUED_SERIAL_MAX = 999999; // lib/server/rfid-serial-allocator.ts

const NEVER_READ = [
  'F0A0B30E4F9C01200003F08D', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9C0120000C76DE', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9C0120000DB8D1', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9D69100004A574', // Crew T-Shirt BROWN XL
  'F0A0B30E4F9D69100005E979', // Crew T-Shirt BROWN XL
  'F0A0B30E4F9C7AF000023564', // Dani Heels BLACK 40
  'F0A0B30E4F9CF5400002B77B', // Nikita Dress BEIGE L
  'F0A0B30E4F9CF460000B7642', // Nikita Dress BEIGE M
];
const MISREAD = [
  'F0A0D30E4F9CADF080019219', // Heartbit Shirt BEIGE XL
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT to_jsonb(i) AS item, l.tenant_id::text AS tenant_id, m.description AS product, c.size
       FROM items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN custom_skus c ON c.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = c.matrix_id
      WHERE i.epc = ANY($1::text[])
      ORDER BY i.epc
      FOR UPDATE OF i`,
    [[...NEVER_READ, ...MISREAD]],
  );
  const problems = [];
  const byEpc = new Map(rows.map((r) => [r.item.epc, r]));
  for (const epc of [...NEVER_READ, ...MISREAD]) {
    const r = byEpc.get(epc);
    if (!r) { problems.push(`${epc}: no item row`); continue; }
    const it = r.item;
    if (it.status !== 'in-stock') problems.push(`${epc}: status is ${it.status}, not LIVE`);
    if (NEVER_READ.includes(epc) && (it.last_seen_at !== null || it.first_scanned_at !== null)) {
      problems.push(`${epc}: has been read (last ${it.last_seen_at})`);
    }
    if (MISREAD.includes(epc)) {
      if (!(Number(it.serial_number) > ISSUED_SERIAL_MAX)) problems.push(`${epc}: serial ${it.serial_number} is an issued one`);
      if (it.last_seen_at && new Date(it.last_seen_at) > new Date('2026-09-27T00:00:00Z')) problems.push(`${epc}: read again ${it.last_seen_at}`);
    }
    console.log(`${epc}  ${r.product} ${r.size}  ${it.status}  last read ${it.last_seen_at ?? 'never'}`);
  }
  if (problems.length) throw new Error(`stopped, nothing changed:\n  ${problems.join('\n  ')}`);
  console.log(`${rows.length} unfindable LIVE tag number(s)`);
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
      const reason = MISREAD.includes(r.item.epc)
        ? 'not found in Bulk Geiger hunt; serial no Carbon encoder issues (damaged-chip misread) (owner 2026-10-15)'
        : 'not found in Bulk Geiger hunt; never read by any reader since created (owner 2026-10-15)';
      await client.query(
        `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
         VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'in-stock', 'unknown', $3, NULL, NULL, NULL)`,
        [r.tenant_id, r.item.epc, reason],
      );
    }
    await client.query('COMMIT');
    console.log(`set ${up.rowCount} to unknown; backup ${BACKUP}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
}
