// LIVE tags whose serial no Carbon encoder issues and that were read on one
// day only → UNKNOWN (owner, 2026-10-15). They are a damaged chip's scrambled
// reads (Startdust Denim Jacket XL showed up as two different numbers, each
// once); as UNKNOWN they stop counting in stock and on Shopify, and a real tag
// comes back LIVE by itself when it is read again (lib/server/epc-ingress).
// Writes the full rows to docs/rfid/evidence first and a STATUS_CHANGE audit row
// per tag.
//
//   DATABASE_URL=… node scripts/oneoffs/unconfirmed-serials-to-unknown-2026-10-15.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/unconfirmed-serials-to-unknown-2026-10-15.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/unconfirmed-serials-backup-2026-10-15.json');
const ISSUED_SERIAL_MAX = 999999; // lib/server/rfid-serial-allocator.ts

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
      WHERE i.epc LIKE 'F0A0B%'
        AND i.serial_number > $1
        AND i.status = 'in-stock'
        AND (i.last_seen_at AT TIME ZONE 'America/New_York')::date = (i.first_scanned_at AT TIME ZONE 'America/New_York')::date
      ORDER BY i.first_scanned_at
      FOR UPDATE OF i`,
    [ISSUED_SERIAL_MAX],
  );
  for (const r of rows) console.log(`${r.item.epc}  ${r.product} ${r.size}  read once ${r.item.first_scanned_at} (${r.item.source})`);
  console.log(`${rows.length} unconfirmed LIVE tag number(s)`);
  if (!WRITE || rows.length === 0) {
    await client.query('ROLLBACK');
    console.log(WRITE ? 'nothing to do' : 'DRY RUN — nothing changed');
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
        [r.tenant_id, r.item.epc, 'unconfirmed tag number: serial no Carbon encoder issues, read on one day only (owner 2026-10-15)'],
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
