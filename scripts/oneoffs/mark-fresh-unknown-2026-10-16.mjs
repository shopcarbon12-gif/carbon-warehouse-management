// Owner, 2026-10-16 — fresh tags rule (migration 0121): mark the UNKNOWN tags a
// scan created from a number never recorded in the WMS as "new, not verified"
// (items.fresh_found_at), so they show on Reports → New Unknown tags and the
// count reports until a person checks them with Cloud + Geiger:
//   - the 8 phantoms of 2026-10-13 (set UNKNOWN by phantom-epcs-to-unknown);
//   - UNKNOWN tags a scan created with a serial no Carbon encoder issues
//     (damaged-chip numbers, 2026-10-15 rule) — never verified by anyone.
// fresh_found_at = when the tag was first read. Other UNKNOWN tags are known
// tags that lost track (they come back LIVE on a scan) and are left alone.
//
//   DATABASE_URL=… node scripts/oneoffs/mark-fresh-unknown-2026-10-16.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/mark-fresh-unknown-2026-10-16.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/mark-fresh-unknown-backup-2026-10-16.json');
const PHANTOMS = [
  'F0A0B30E4F9BB7E000012502', 'F0A0B30E4F9C8440000191A0', 'F0A0B30E4F9BBF40000126AD', 'F0A0B30E4F9B9D7000002212',
  'F0A0B30E4F9CB3100001A196', 'F0A0B30E4F9C28B000013029', 'F0A0B30E4F9D0810000186FB', 'F0A0B30E4F9C760000018C09',
];
const SCAN_SOURCES = ['fixed_reader', 'handheld', 'cycle_count', 'count_inventory', 'count_inventory_override', 'add_on_count'];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT i.epc, i.status, i.serial_number::text AS serial, i.source, i.first_scanned_at, i.created_at,
            m.description AS product, c.size
       FROM items i
       LEFT JOIN custom_skus c ON c.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = c.matrix_id
      WHERE i.status = 'unknown' AND i.fresh_found_at IS NULL
        AND (i.epc = ANY($1::text[]) OR (i.serial_number > 999999 AND i.source = ANY($2::text[])))
      ORDER BY i.epc
      FOR UPDATE OF i`,
    [PHANTOMS, SCAN_SOURCES],
  );
  const phantoms = rows.filter((r) => PHANTOMS.includes(r.epc)).length;
  for (const r of rows) console.log(`${r.epc}  ${r.product ?? '—'} ${r.size ?? ''}  serial ${r.serial}  first read ${r.first_scanned_at?.toISOString?.() ?? 'never'}`);
  console.log(`${rows.length} to mark (${phantoms} of the 8 phantoms, ${rows.length - phantoms} damaged-chip numbers)`);
  if (phantoms !== PHANTOMS.length) throw new Error(`expected all 8 phantoms UNKNOWN and unmarked, found ${phantoms}`);
  if (!WRITE) {
    await client.query('ROLLBACK');
    console.log('DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 1));
    const up = await client.query(
      `UPDATE items SET fresh_found_at = COALESCE(first_scanned_at, created_at)
        WHERE epc = ANY($1::text[]) AND status = 'unknown' AND fresh_found_at IS NULL`,
      [rows.map((r) => r.epc)],
    );
    if (up.rowCount !== rows.length) throw new Error(`expected ${rows.length} updates, got ${up.rowCount}`);
    await client.query('COMMIT');
    console.log(`marked ${up.rowCount}; backup ${path.relative(process.cwd(), BACKUP)}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
