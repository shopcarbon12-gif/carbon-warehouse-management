// Data repair for the shared bin engine (owner, 2026-10-16: desktop ↔ handheld
// bin review → "you can start to build").
//   1. LIVE / pending tags with no live primary bin but a live EXTRA bin
//      ("half-homed": Clean and Delete used to clear the primary without
//      promoting the extra) → the first live extra bin becomes the primary.
//      They showed "—" in the catalog and RFID popup while Shelf Map and bin
//      contents listed them. Engine rule: planRemove in lib/server/bin-engine.ts.
//   2. Tags listing their primary bin again as an extra bin → duplicate dropped
//      (Shelf Map ADD set the primary without removing it from the extras).
//   3. History rows written by this session's maintenance scripts with no
//      device (2026-10-15 / 16: unfindable / unconfirmed → UNKNOWN, sibling-bin
//      backfills) → device_id 'repair-script-2026-10-16', so Activity shows them
//      as System instead of Handheld / Not recorded.
// Writes restore fields to docs/rfid/evidence first; one bin_move audit row per
// promoted tag.
//
//   DATABASE_URL=… node scripts/oneoffs/bin-homes-repair-2026-10-16.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/bin-homes-repair-2026-10-16.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/bin-homes-repair-backup-2026-10-16.json');
const DEVICE = 'repair-script-2026-10-16';
const MY_SCRIPT_BACKUPS = [
  'docs/rfid/evidence/sibling-bins-backup-2026-10-16.json',
  'docs/rfid/evidence/sibling-bins-backfill-backup-2026-10-16.json',
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');

  const half = await client.query(
    `SELECT i.id::text, i.epc, l.tenant_id::text AS tenant_id, i.status,
            i.bin_id::text AS old_bin, i.additional_bin_ids::text[] AS old_extra,
            p.promote::text AS promote, pb.code AS promote_code,
            m.description AS product, cs.color_code AS color, cs.size
       FROM items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = cs.matrix_id
       CROSS JOIN LATERAL (
         SELECT u.x AS promote
           FROM unnest(i.additional_bin_ids) WITH ORDINALITY AS u(x, o)
           JOIN bins b ON b.id = u.x AND b.archived_at IS NULL AND b.location_id = i.location_id
          ORDER BY u.o
          LIMIT 1
       ) p
       JOIN bins pb ON pb.id = p.promote
      WHERE i.status IN ('in-stock', 'pending_visibility')
        AND (i.bin_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM bins b2 WHERE b2.id = i.bin_id AND b2.archived_at IS NULL))
      ORDER BY m.description, cs.color_code, cs.size, i.epc
      FOR UPDATE OF i`,
  );
  const dup = await client.query(
    `SELECT i.id::text, i.epc, i.bin_id::text AS old_bin, i.additional_bin_ids::text[] AS old_extra
       FROM items i
      WHERE i.bin_id = ANY(i.additional_bin_ids)
      FOR UPDATE OF i`,
  );
  const byProduct = new Map();
  for (const r of half.rows) {
    const k = `${r.product} ${r.color} ${r.size} → ${r.promote_code}`;
    byProduct.set(k, (byProduct.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byProduct) console.log(`${String(n).padStart(3)} × ${k}`);
  console.log(`\nhalf-homed tags to promote: ${half.rows.length}`);
  console.log(`tags listing their primary bin as an extra too: ${dup.rows.length}`);

  const epcs = new Set();
  for (const f of MY_SCRIPT_BACKUPS) {
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const r of j.rows ?? []) epcs.add(r.epc ?? r.item?.epc);
  }
  const mine = await client.query(
    `SELECT count(*)::int AS n FROM inventory_audit_logs
      WHERE device_id IS NULL AND user_uuid IS NULL
        AND created_at >= '2026-10-15T00:00:00Z'
        AND ((reason IN ('bin_move', 'bin_add') AND entity_reference = ANY($1::text[]))
             OR reason LIKE 'not found in Bulk Geiger hunt%'
             OR reason LIKE 'unconfirmed tag number%')`,
    [[...epcs]],
  );
  console.log(`maintenance-script history rows to mark as System: ${mine.rows[0].n}`);

  if (!WRITE) {
    await client.query('ROLLBACK');
    console.log('DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({
      takenAt: new Date().toISOString(),
      restore: 'UPDATE items SET bin_id = old_bin, additional_bin_ids = old_extra WHERE id = id',
      promoted: half.rows.map(({ id, epc, old_bin, old_extra, promote }) => ({ id, epc, old_bin, old_extra, new_bin: promote })),
      deduplicated: dup.rows,
    }, null, 1));
    const up = await client.query(
      `UPDATE items i
          SET bin_id = p.promote, additional_bin_ids = array_remove(i.additional_bin_ids, p.promote)
         FROM jsonb_to_recordset($1::jsonb) AS p(id uuid, promote uuid, old_bin uuid, old_extra uuid[])
        WHERE i.id = p.id
          AND i.bin_id IS NOT DISTINCT FROM p.old_bin
          AND i.additional_bin_ids = p.old_extra`,
      [JSON.stringify(half.rows.map((r) => ({ id: r.id, promote: r.promote, old_bin: r.old_bin, old_extra: r.old_extra })))],
    );
    if (up.rowCount !== half.rows.length) throw new Error(`expected ${half.rows.length} promotions, got ${up.rowCount}`);
    await client.query(
      `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
       SELECT a.tenant_id, 'ADJUSTMENT', 'EPC', a.epc, '(homeless)', a.code, 'bin_move', NULL, NULL, $2
         FROM jsonb_to_recordset($1::jsonb) AS a(tenant_id uuid, epc text, code text)`,
      [JSON.stringify(half.rows.map((r) => ({ tenant_id: r.tenant_id, epc: r.epc, code: r.promote_code }))), DEVICE],
    );
    const dd = await client.query(
      `UPDATE items SET additional_bin_ids = array_remove(additional_bin_ids, bin_id)
        WHERE id = ANY($1::uuid[]) AND bin_id = ANY(additional_bin_ids)`,
      [dup.rows.map((r) => r.id)],
    );
    const tag = await client.query(
      `UPDATE inventory_audit_logs SET device_id = $2
        WHERE device_id IS NULL AND user_uuid IS NULL
          AND created_at >= '2026-10-15T00:00:00Z'
          AND ((reason IN ('bin_move', 'bin_add') AND entity_reference = ANY($1::text[]))
               OR reason LIKE 'not found in Bulk Geiger hunt%'
               OR reason LIKE 'unconfirmed tag number%')`,
      [[...epcs], DEVICE],
    );
    await client.query('COMMIT');
    console.log(`promoted ${up.rowCount}, de-duplicated ${dd.rowCount}, marked ${tag.rowCount} history rows as System; backup ${BACKUP}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
}
