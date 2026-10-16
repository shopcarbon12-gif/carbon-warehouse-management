// 11 tags from the 2026-10-15 Bulk Geiger hunt that had no bin although every
// other LIVE tag of their product sits in one bin (owner, 2026-10-16). They
// entered after the product was put in its bin (count / Add-On / encode), and
// nothing gave a late tag a bin — migration 0118 now does it for new tags.
// Same rule as 0118: the other LIVE tags of the same SKU at the same location
// must all have the same home — primary bin + extra (multi-bin) bins — and the
// tag gets exactly that home; if they disagree it is skipped.
// Writes the full rows to docs/rfid/evidence first, then audit rows like the
// handheld's bin assign: bin_move (homeless) → primary, bin_add per extra bin.
//
//   DATABASE_URL=… node scripts/oneoffs/sibling-bins-for-unfound-2026-10-16.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/sibling-bins-for-unfound-2026-10-16.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/sibling-bins-backup-2026-10-16.json');

const EPCS = [
  'F0A0B30E4F9C8440000191A0', // Apology Hoodie BLACK L
  'F0A0B30E4F9CB3100001A196', // Carbon Classic T WHITE XXXL
  'F0A0B30E4F9BDAB0000C7BA2', // Choose Carbon T-Shirt WHITE XXL
  'F0A0B30E4F9CDCD00002FA24', // Cory Jeans BLUE WASHED 38
  'F0A0B30E4F9C7AF000023564', // Dani Heels BLACK 40
  'F0A0B30E4F9B9D7000002212', // Finn Jeans BLUE 30
  'F0A0B30E4F9BBF40000126AD', // Marlee Crop Top BLACK 38
  'F0A0B30E4F9CF5400002B77B', // Nikita Dress BEIGE L
  'F0A0B30E4F9CF460000B7642', // Nikita Dress BEIGE M
  'F0A0B30E4F9BB7E000012502', // Rhea Jacket WHITE S
  'F0A0B30E4F9D0810000186FB', // Russell Jacket BLACK S
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  // Each distinct home (primary bin + sorted live extra bins) among the other
  // LIVE tags of the product — same expression as the 0118 trigger.
  const { rows } = await client.query(
    `SELECT to_jsonb(i) AS item, l.tenant_id::text AS tenant_id, m.description AS product, c.size,
            (SELECT jsonb_agg(DISTINCT jsonb_build_object('bin', h.bin, 'extra', h.extra))
               FROM (SELECT s.bin_id::text AS bin,
                            COALESCE((SELECT array_agg(a.id::text ORDER BY a.id)
                                        FROM unnest(s.additional_bin_ids) AS a(id)
                                        JOIN bins ab ON ab.id = a.id AND ab.location_id = i.location_id AND ab.archived_at IS NULL
                                       WHERE a.id <> s.bin_id), '{}'::text[]) AS extra
                       FROM items s
                       JOIN bins pb ON pb.id = s.bin_id AND pb.location_id = i.location_id AND pb.archived_at IS NULL
                      WHERE s.custom_sku_id = i.custom_sku_id
                        AND s.location_id = i.location_id
                        AND s.status = 'in-stock'
                        AND s.id <> i.id) h) AS homes
       FROM items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN custom_skus c ON c.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = c.matrix_id
      WHERE i.epc = ANY($1::text[])
      ORDER BY m.description, c.size
      FOR UPDATE OF i`,
    [EPCS],
  );
  const binCode = new Map(
    (await client.query(`SELECT id::text, code FROM bins`)).rows.map((b) => [b.id, b.code]),
  );
  const show = (h) => binCode.get(h.bin) + (h.extra.length ? ` (+ ${h.extra.map((x) => binCode.get(x)).join(', ')})` : '');
  const todo = [];
  for (const r of rows) {
    const homes = r.homes ?? [];
    const label = `${r.item.epc}  ${r.product} ${r.size}`;
    if (r.item.bin_id) console.log(`${label}  SKIP already in ${binCode.get(r.item.bin_id)}`);
    else if (homes.length !== 1) console.log(`${label}  SKIP the product's tags disagree: ${homes.map(show).join(' / ') || 'no bin'}`);
    else {
      console.log(`${label}  → ${show(homes[0])}`);
      todo.push({ ...r, bin: homes[0].bin, extra: homes[0].extra });
    }
  }
  const missing = EPCS.filter((e) => !rows.some((r) => r.item.epc === e));
  if (missing.length) throw new Error(`no item row for ${missing.join(', ')}`);
  console.log(`${todo.length} of ${EPCS.length} tag(s) get a bin`);
  if (!WRITE || todo.length === 0) {
    await client.query('ROLLBACK');
    console.log(WRITE ? 'nothing to do' : 'DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 1));
    for (const t of todo) {
      const up = await client.query(
        `UPDATE items SET bin_id = $1::uuid, additional_bin_ids = $2::uuid[] WHERE id = $3::uuid AND bin_id IS NULL`,
        [t.bin, t.extra, t.item.id],
      );
      if (up.rowCount !== 1) throw new Error(`${t.item.epc}: expected 1 update, got ${up.rowCount}`);
      // Same audit shape as the handheld: bin_move for the primary, bin_add per extra bin.
      for (const [reason, bin] of [['bin_move', t.bin], ...t.extra.map((x) => ['bin_add', x])]) {
        await client.query(
          `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
           VALUES ($1::uuid, 'ADJUSTMENT', 'EPC', $2, '(homeless)', $3, $4, NULL, NULL, NULL)`,
          [t.tenant_id, t.item.epc, binCode.get(bin), reason],
        );
      }
    }
    await client.query('COMMIT');
    console.log(`gave ${todo.length} tag(s) their product's bin; backup ${BACKUP}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
}
