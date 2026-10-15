// Remove re-encoded EPCs whose old row is still LIVE next to its LIVE
// replacement — the same garment counted twice.
//
// encode-finalize deletes the old EPC's row only when the new tag is live at
// the operator's location in the same request; when that didn't happen the old
// row stayed in-stock forever (9 found from the Sept 8 / 15 re-encodes). Uses
// the retired rule from lib/server/retired-epcs.ts: a TRUSTED write (created
// from 2026-06-06 on, or an earlier one whose new EPC really exists), not
// written again since. Writes the full rows to docs/rfid/evidence first.
//
//   DATABASE_URL=… node scripts/oneoffs/retired-epc-double-counts-2026-10-14.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/retired-epc-double-counts-2026-10-14.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/retired-epc-double-counts-backup-2026-10-14.json');

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
          AND (e.created_at >= '2026-06-06'::timestamptz
               OR EXISTS (SELECT 1 FROM items v WHERE v.epc = e.new_epc AND v.status <> 'unknown'))
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
        AND ni.status = 'in-stock'
      ORDER BY i.epc
      FOR UPDATE OF i`,
  );
  for (const r of rows) {
    console.log(`${r.item.epc}  old row since ${r.item.created_at}, last seen ${r.item.last_seen_at}  re-encoded ${r.retired_at.toISOString()} → ${r.new_epc} (${r.new_status})`);
  }
  console.log(`${rows.length} double-counted EPC(s)`);
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
