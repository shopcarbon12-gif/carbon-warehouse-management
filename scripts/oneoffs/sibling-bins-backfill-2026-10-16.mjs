// Backfill for migration 0118 (owner, 2026-10-16: "give the 328 other Live tags
// without a bin their product's bin the same way"). 0118 only gives NEW tags
// their product's home; this gives it to the LIVE tags that already exist
// without one (bin_id NULL or pointing at an archived bin).
// Same rule as 0118: the other LIVE tags of the same SKU at the same location
// that have a live primary bin must all share one home — primary bin AND the
// same live extra (multi-bin) bins — and the tag gets exactly that home.
// Disagreement or no home → left alone. A tag that already lists extra bins of
// its own keeps going only when those bins are all part of the product's home
// (Callie Top Set CREAM: listed in 4E05L as an extra while every other tag has
// 4E05L as its primary); any other bin means someone placed it by hand → skip.
// Writes the restore fields of every changed row to docs/rfid/evidence first,
// then audit rows like the handheld's bin assign: bin_move → primary, bin_add
// per extra bin.
//
//   DATABASE_URL=… node scripts/oneoffs/sibling-bins-backfill-2026-10-16.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/sibling-bins-backfill-2026-10-16.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/sibling-bins-backfill-backup-2026-10-16.json');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `WITH live AS (
       SELECT location_id, array_agg(id) AS ids FROM bins WHERE archived_at IS NULL GROUP BY location_id
     )
     SELECT i.id::text, i.epc, i.status, i.bin_id::text AS old_bin_id, i.additional_bin_ids::text[] AS old_extra,
            l.tenant_id::text AS tenant_id, m.description AS product, c.color_code AS color, c.size,
            (SELECT jsonb_agg(DISTINCT jsonb_build_object('bin', h.bin, 'extra', h.extra))
               FROM (SELECT s.bin_id::text AS bin,
                            COALESCE((SELECT array_agg(a.id::text ORDER BY a.id)
                                        FROM unnest(s.additional_bin_ids) AS a(id)
                                       WHERE a.id <> s.bin_id AND a.id = ANY(lv.ids)), '{}'::text[]) AS extra
                       FROM items s
                      WHERE s.custom_sku_id = i.custom_sku_id
                        AND s.location_id = i.location_id
                        AND s.status = 'in-stock'
                        AND s.id <> i.id
                        AND s.bin_id = ANY(lv.ids)) h) AS homes
       FROM items i
       JOIN locations l ON l.id = i.location_id
       JOIN live lv ON lv.location_id = i.location_id
       LEFT JOIN custom_skus c ON c.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = c.matrix_id
      WHERE i.status = 'in-stock'
        AND i.custom_sku_id IS NOT NULL
        AND (i.bin_id IS NULL OR NOT (i.bin_id = ANY(lv.ids)))
      ORDER BY m.description, c.color_code, c.size, i.epc
      FOR UPDATE OF i`,
  );
  const binCode = new Map(
    (await client.query(`SELECT id::text, code FROM bins`)).rows.map((b) => [b.id, b.code]),
  );
  const show = (h) => binCode.get(h.bin) + (h.extra.length ? ` (+ ${h.extra.map((x) => binCode.get(x)).join(', ')})` : '');

  const plan = [];
  let noHome = 0, disagree = 0, ownExtras = 0;
  for (const r of rows) {
    const homes = r.homes ?? [];
    if (homes.length === 0) { noHome++; continue; }
    if (homes.length > 1) { disagree++; console.log(`SKIP ${r.epc} ${r.product} ${r.color} ${r.size}: tags disagree ${homes.map(show).join(' / ')}`); continue; }
    const homeSet = new Set([homes[0].bin, ...homes[0].extra]);
    if ((r.old_extra ?? []).some((x) => !homeSet.has(x))) { ownExtras++; console.log(`SKIP ${r.epc} ${r.product} ${r.color} ${r.size}: lists extra bins outside the product's home`); continue; }
    plan.push({ ...r, bin: homes[0].bin, extra: homes[0].extra, home: show(homes[0]) });
  }
  const byProduct = new Map();
  for (const p of plan) {
    const k = `${p.product} ${p.color} ${p.size} → ${p.home}`;
    byProduct.set(k, (byProduct.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byProduct) console.log(`${String(n).padStart(3)} × ${k}`);
  console.log(`\nLIVE tags without a live bin: ${rows.length}`);
  console.log(`  get their product's home: ${plan.length}`);
  console.log(`  no tag of the product has a bin: ${noHome}`);
  console.log(`  product's tags disagree: ${disagree}`);
  console.log(`  already list extra bins of their own: ${ownExtras}`);

  if (!WRITE || plan.length === 0) {
    await client.query('ROLLBACK');
    console.log(WRITE ? 'nothing to do' : 'DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({
      takenAt: new Date().toISOString(),
      restore: 'UPDATE items SET bin_id = old_bin_id, additional_bin_ids = old_extra WHERE id = id',
      rows: plan.map((p) => ({ id: p.id, epc: p.epc, product: `${p.product} ${p.color} ${p.size}`, old_bin_id: p.old_bin_id, old_extra: p.old_extra, new_bin_id: p.bin, new_extra: p.extra })),
    }, null, 1));
    const payload = JSON.stringify(plan.map((p) => ({ id: p.id, old_bin: p.old_bin_id, old_extra: p.old_extra ?? [], bin: p.bin, extra: p.extra })));
    const up = await client.query(
      `UPDATE items i
          SET bin_id = p.bin, additional_bin_ids = p.extra
         FROM jsonb_to_recordset($1::jsonb) AS p(id uuid, old_bin uuid, old_extra uuid[], bin uuid, extra uuid[])
        WHERE i.id = p.id
          AND i.status = 'in-stock'
          AND i.bin_id IS NOT DISTINCT FROM p.old_bin
          AND i.additional_bin_ids = p.old_extra`,
      [payload],
    );
    if (up.rowCount !== plan.length) throw new Error(`expected ${plan.length} updates, got ${up.rowCount}`);
    const audit = [];
    for (const p of plan) {
      const from = p.old_bin_id ? (binCode.get(p.old_bin_id) ?? '(homeless)') : '(homeless)';
      audit.push({ tenant_id: p.tenant_id, epc: p.epc, old_value: from, new_value: binCode.get(p.bin), reason: 'bin_move' });
      const had = new Set(p.old_extra ?? []);
      for (const x of p.extra) {
        if (!had.has(x)) audit.push({ tenant_id: p.tenant_id, epc: p.epc, old_value: '(homeless)', new_value: binCode.get(x), reason: 'bin_add' });
      }
    }
    const ins = await client.query(
      `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
       SELECT a.tenant_id, 'ADJUSTMENT', 'EPC', a.epc, a.old_value, a.new_value, a.reason, NULL, NULL, NULL
         FROM jsonb_to_recordset($1::jsonb) AS a(tenant_id uuid, epc text, old_value text, new_value text, reason text)`,
      [JSON.stringify(audit)],
    );
    await client.query('COMMIT');
    console.log(`gave ${up.rowCount} LIVE tag(s) their product's home; ${ins.rowCount} audit rows; backup ${BACKUP}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
}
