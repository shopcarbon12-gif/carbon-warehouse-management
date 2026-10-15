// Remove EPCs that were re-encoded away and then brought back LIVE by a scan.
//
// A re-encode deletes the old EPC's items row once the new tag is live. Before
// lib/server/retired-epcs.ts, a later read of the old EPC (an Add-On Count
// session uploading a read taken hours before the encode) looked brand-new and
// went LIVE again — the same garment counted twice, once under the old SKU.
//
// Deletes only rows that are: retired (verified re-encode, not written again
// since), re-created AFTER that encode, LIVE now, and whose replacement EPC is
// LIVE too. Writes the full rows to docs/rfid/evidence first. Same delete the
// encode itself does (app/api/rfid/encode-finalize).
//
//   DATABASE_URL=… node scripts/oneoffs/retired-epc-revivals-2026-10-14.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/retired-epc-revivals-2026-10-14.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/retired-epc-revivals-backup-2026-10-14.json');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `WITH last_retire AS (
       SELECT DISTINCT ON (e.old_epc) e.old_epc, e.new_epc,
              COALESCE(e.encoded_at, e.created_at) AS retired_at
         FROM encode_events e
        WHERE e.status = 'ok'
          AND NOT EXISTS (
                SELECT 1 FROM encode_events n
                 WHERE n.status = 'ok' AND n.new_epc = e.old_epc
                   AND COALESCE(n.encoded_at, n.created_at) > COALESCE(e.encoded_at, e.created_at))
        ORDER BY e.old_epc, COALESCE(e.encoded_at, e.created_at) DESC
     )
     SELECT to_jsonb(i) AS item, r.new_epc, r.retired_at, ni.status AS new_status
       FROM last_retire r
       JOIN items i ON i.epc = r.old_epc
       JOIN items ni ON ni.epc = r.new_epc
      WHERE i.status = 'in-stock'
        AND i.created_at > r.retired_at
        AND ni.status = 'in-stock'
      ORDER BY i.created_at
      FOR UPDATE OF i`,
  );
  for (const r of rows) {
    console.log(`${r.item.epc}  revived ${r.item.created_at} (${r.item.source})  replaced by ${r.new_epc} (${r.new_status})`);
  }
  console.log(`${rows.length} revived EPC(s)`);
  if (!WRITE || rows.length === 0) {
    await client.query('ROLLBACK');
    console.log(WRITE ? 'nothing to do' : 'DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 1));
    const ids = rows.map((r) => r.item.id);
    const del = await client.query(`DELETE FROM items WHERE id = ANY($1::uuid[]) AND status = 'in-stock'`, [ids]);
    if (del.rowCount !== ids.length) throw new Error(`expected ${ids.length} deletes, got ${del.rowCount}`);
    await client.query('COMMIT');
    console.log(`deleted ${del.rowCount}; backup ${BACKUP}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
}
