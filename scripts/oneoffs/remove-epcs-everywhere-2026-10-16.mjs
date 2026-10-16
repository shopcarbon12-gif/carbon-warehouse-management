// Owner, 2026-10-16: "remove completely from everywhere" — 19 tag numbers the
// Bulk Geiger hunt never found:
//   - 9 UNKNOWN: 8 no reader ever read (June re-encode chains, Nikita, Crew,
//     Dani) and Heartbit's misread number — all set UNKNOWN 2026-10-15;
//   - 10 LIVE last read May 30 – Jun 7 (their sizes drop by one on Shopify on
//     the next inventory sync).
// Removed from: items (phones drop them via the live-catalog tombstone
// trigger), tag history, the Cloud + Geiger queue, Geiger sessions, Add-On
// ledgers / per-tag rows / events, count sessions (expected, scanned, sources)
// and the report CSVs (count reports, device uploads). Kept: encode_events —
// they are what keeps the OLD numbers of those re-encodes retired (ghosted);
// deleting them would let another tag come back LIVE. The activity log's
// per-tag rows go in a second step (--logs, a 2.7M-row table).
// Every removed row / line / JSON entry is written to docs/rfid/evidence first.
//
//   DATABASE_URL=… node scripts/oneoffs/remove-epcs-everywhere-2026-10-16.mjs            # dry run
//   DATABASE_URL=… node scripts/oneoffs/remove-epcs-everywhere-2026-10-16.mjs --write
//   DATABASE_URL=… node scripts/oneoffs/remove-epcs-everywhere-2026-10-16.mjs --logs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const LOGS = process.argv.includes('--logs');
const BACKUP = path.resolve(
  `docs/rfid/evidence/removed-epcs-${LOGS ? 'activity-log-' : ''}backup-2026-10-16.json`,
);

const UNKNOWN_NEVER_READ = [
  'F0A0B30E4F9C01200003F08D', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9C0120000C76DE', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9C0120000DB8D1', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9D69100004A574', // Crew T-Shirt BROWN XL
  'F0A0B30E4F9D69100005E979', // Crew T-Shirt BROWN XL
  'F0A0B30E4F9C7AF000023564', // Dani Heels BLACK 40
  'F0A0B30E4F9CF5400002B77B', // Nikita Dress BEIGE L
  'F0A0B30E4F9CF460000B7642', // Nikita Dress BEIGE M
  // Added by the owner the same day: UNKNOWN since 2026-10-15, a damaged chip's
  // misread (serial no Carbon encoder issues) last read at transfer receiving.
  'F0A0D30E4F9CADF080019219', // Heartbit Shirt BEIGE XL
];
const LIVE = [
  'F0A0B30E4F9CA82000018DF2', // Show Must Go On Shirt BLACK M
  'F0A0B30E4F9CB2200001A071', // Street Shirt WHITE XXXL
  'F0A0B30E4F9CD1D000018815', // Texture Top GREY L
  'F0A0B30E4F9B963000001344', // Vick Jeans BLUE WASHED 34
  'F0A0B30E4F9C012000000005', // Trent Denim Shorts GREY WASHED 32
  'F0A0B30E4F9D67C00001883A', // Gothic T-Shirt Set BEIGE L
  'F0A0B30E4F9BD86000001715', // Social T-Shirt WHITE L
  'F0A0B30E4F9BD87000013BE6', // Social T-Shirt WHITE XL
  'F0A0B30E4F9C221000000517', // Logo Sneakers BLACK 45
  'F0A0B30E4F9BE700000186A1', // Keep Rising T-Shirt WHITE M
];
const EPCS = [...UNKNOWN_NEVER_READ, ...LIVE];
const PAT = EPCS.join('|');
const HUNT_START = new Date('2026-10-15T00:00:00Z');

/** Drops every line that carries one of the EPCs; returns the new text and the dropped lines. */
function stripLines(text) {
  if (!text) return { text, dropped: [] };
  const lines = text.split(/\r?\n/);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const dropped = lines.filter((l) => EPCS.some((e) => l.includes(e)));
  if (!dropped.length) return { text, dropped };
  return { text: lines.filter((l) => !EPCS.some((e) => l.includes(e))).join(nl), dropped };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
const q = (sql, params = [EPCS]) => client.query(sql, params);
try {
  await q("SET statement_timeout = '15min'", []);
  await client.query('BEGIN');
  const backup = { takenAt: new Date().toISOString(), epcs: EPCS };
  const counts = {};

  if (LOGS) {
    // Activity log: the tags' own rows (reader zone moves, entity epc:<EPC>) and
    // their LIVE-transition events. API request logs that list them among other
    // tags are left as they are.
    const ents = EPCS.map((e) => `epc:${e}`);
    const rows = (await q(
      `SELECT to_jsonb(a) r FROM audit_log a
        WHERE a.entity = ANY($1) OR (a.action = 'item_live_transition' AND a.metadata::text ~ $2)`,
      [ents, PAT],
    )).rows.map((r) => r.r);
    backup.audit_log = rows;
    counts.audit_log = rows.length;
    if (WRITE) {
      fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
      fs.writeFileSync(BACKUP, JSON.stringify(backup));
      const d = await q(`DELETE FROM audit_log WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
      if (d.rowCount !== rows.length) throw new Error(`audit_log: expected ${rows.length}, deleted ${d.rowCount}`);
    }
  } else {
    // Guard: all 18 still there, as expected, and none read since the hunt.
    const items = (await q(`SELECT to_jsonb(i) r FROM items i WHERE i.epc = ANY($1) FOR UPDATE`)).rows.map((r) => r.r);
    const problems = [];
    for (const epc of EPCS) {
      const it = items.find((i) => i.epc === epc);
      if (!it) { problems.push(`${epc}: no item row`); continue; }
      const want = UNKNOWN_NEVER_READ.includes(epc) ? 'unknown' : 'in-stock';
      if (it.status !== want) problems.push(`${epc}: status ${it.status}, expected ${want}`);
      if (it.last_seen_at && new Date(it.last_seen_at) >= HUNT_START) problems.push(`${epc}: read ${it.last_seen_at}`);
    }
    if (problems.length) throw new Error(`stopped, nothing changed:\n  ${problems.join('\n  ')}`);
    backup.items = items;

    const grab = async (key, sql) => {
      backup[key] = (await q(sql)).rows.map((r) => r.r);
      counts[key] = backup[key].length;
    };
    await grab('inventory_audit_logs', `SELECT to_jsonb(a) r FROM inventory_audit_logs a WHERE a.entity_reference = ANY($1)`);
    await grab('device_epc_queue', `SELECT to_jsonb(d) r FROM device_epc_queue d WHERE d.epc = ANY($1)`);
    await grab('locate_sessions', `SELECT to_jsonb(s) r FROM locate_sessions s WHERE s.target_epc = ANY($1) OR s.confirmed_epc = ANY($1)`);
    await grab('add_on_session_epcs', `SELECT to_jsonb(e) r FROM add_on_session_epcs e WHERE e.epc = ANY($1)`);
    await grab('add_on_sessions', `SELECT jsonb_build_object('id', s.id, 'epc_count', s.epc_count,
        'removed', (SELECT jsonb_object_agg(k, v) FROM jsonb_each(s.epc_ledger) x(k, v) WHERE k = ANY($1))) r
        FROM add_on_sessions s WHERE s.epc_ledger ?| $1`);
    await grab('add_on_session_events', `SELECT jsonb_build_object('id', e.id, 'payload', e.payload) r
        FROM add_on_session_events e WHERE e.payload->>'epc' = ANY($1) OR e.payload->'epcs' ?| $1`);
    await grab('cycle_count_sessions', `SELECT jsonb_build_object('id', c.id, 'session_number', c.session_number,
        'expected', (SELECT jsonb_agg(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.expected_snapshot) = 'array' THEN c.expected_snapshot ELSE '[]' END) x WHERE x->>'epc' = ANY($1)),
        'scanned', (SELECT jsonb_agg(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.scanned_epcs) = 'array' THEN c.scanned_epcs ELSE '[]' END) x WHERE x #>> '{}' = ANY($1)),
        'sources', (SELECT jsonb_object_agg(k, v) FROM jsonb_each(CASE WHEN jsonb_typeof(c.scanned_epc_sources) = 'object' THEN c.scanned_epc_sources ELSE '{}' END) y(k, v) WHERE k = ANY($1))) r
        FROM cycle_count_sessions c
       WHERE c.expected_snapshot::text ~ $2 OR c.scanned_epcs::text ~ $2 OR c.scanned_epc_sources::text ~ $2`.replace('$2', '$2').replace(/\$2/g, `'${PAT}'`));

    const uploads = (await q(`SELECT id, raw_csv FROM device_upload_logs WHERE raw_csv ~ $1`, [PAT])).rows;
    const reports = (await q(`SELECT id, csv_content, defective_csv_blob, row_count, defective_row_count
        FROM inventory_reports WHERE csv_content ~ $1 OR defective_csv_blob ~ $1`, [PAT])).rows;
    backup.device_upload_logs = [];
    backup.inventory_reports = [];
    const uploadEdits = uploads.map((u) => {
      const s = stripLines(u.raw_csv);
      backup.device_upload_logs.push({ id: u.id, dropped: s.dropped });
      return { id: u.id, text: s.text };
    });
    const reportEdits = reports.map((r) => {
      const a = stripLines(r.csv_content);
      const b = stripLines(r.defective_csv_blob);
      backup.inventory_reports.push({ id: r.id, row_count: r.row_count, defective_row_count: r.defective_row_count, dropped: a.dropped, droppedDefective: b.dropped });
      return {
        id: r.id, csv: a.text, def: b.text,
        rows: r.row_count == null ? null : Math.max(0, r.row_count - a.dropped.length),
        defRows: r.defective_row_count == null ? null : Math.max(0, r.defective_row_count - b.dropped.length),
      };
    });
    counts.device_upload_logs = uploads.length;
    counts.inventory_reports = reports.length;
    counts.items = items.length;

    if (WRITE) {
      fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
      fs.writeFileSync(BACKUP, JSON.stringify(backup));
      const del = async (sql, want, what) => {
        const r = await q(sql);
        if (want != null && r.rowCount !== want) throw new Error(`${what}: expected ${want}, got ${r.rowCount}`);
      };
      await del(`DELETE FROM items WHERE epc = ANY($1)`, items.length, 'items');
      await del(`DELETE FROM inventory_audit_logs WHERE entity_reference = ANY($1)`, counts.inventory_audit_logs, 'inventory_audit_logs');
      await del(`DELETE FROM device_epc_queue WHERE epc = ANY($1)`, counts.device_epc_queue, 'device_epc_queue');
      await del(`DELETE FROM locate_sessions WHERE target_epc = ANY($1) OR confirmed_epc = ANY($1)`, counts.locate_sessions, 'locate_sessions');
      await del(`DELETE FROM add_on_session_epcs WHERE epc = ANY($1)`, counts.add_on_session_epcs, 'add_on_session_epcs');
      await del(`UPDATE add_on_sessions s
          SET epc_count = GREATEST(0, s.epc_count - (SELECT count(*) FROM jsonb_object_keys(s.epc_ledger) k WHERE k = ANY($1))),
              epc_ledger = s.epc_ledger - $1::text[]
        WHERE s.epc_ledger ?| $1`, counts.add_on_sessions, 'add_on_sessions');
      await del(`DELETE FROM add_on_session_events WHERE payload->>'epc' = ANY($1)`, null, 'add_on_session_events');
      await del(`UPDATE add_on_session_events e
          SET payload = jsonb_set(e.payload, '{epcs}', COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(e.payload->'epcs') x WHERE NOT (x #>> '{}' = ANY($1))), '[]'::jsonb))
        WHERE e.payload->'epcs' ?| $1`, null, 'add_on_session_events');
      await client.query(`DELETE FROM add_on_session_events WHERE payload->'epcs' = '[]'::jsonb AND event_type = 'epc_new'`);
      await del(`UPDATE cycle_count_sessions c SET
          expected_snapshot = CASE WHEN jsonb_typeof(c.expected_snapshot) = 'array'
            THEN COALESCE((SELECT jsonb_agg(x ORDER BY o) FROM jsonb_array_elements(c.expected_snapshot) WITH ORDINALITY z(x, o) WHERE NOT (x->>'epc' = ANY($1))), '[]'::jsonb)
            ELSE c.expected_snapshot END,
          scanned_epcs = CASE WHEN jsonb_typeof(c.scanned_epcs) = 'array'
            THEN COALESCE((SELECT jsonb_agg(x ORDER BY o) FROM jsonb_array_elements(c.scanned_epcs) WITH ORDINALITY z(x, o) WHERE NOT (x #>> '{}' = ANY($1))), '[]'::jsonb)
            ELSE c.scanned_epcs END,
          scanned_epc_sources = CASE WHEN jsonb_typeof(c.scanned_epc_sources) = 'object'
            THEN c.scanned_epc_sources - $1::text[] ELSE c.scanned_epc_sources END
        WHERE c.id = ANY($2::uuid[])`.replace('$2::uuid[]', `ARRAY[${backup.cycle_count_sessions.map((c) => `'${c.id}'`).join(',') || 'NULL'}]::uuid[]`),
        counts.cycle_count_sessions, 'cycle_count_sessions');
      for (const e of uploadEdits) await q(`UPDATE device_upload_logs SET raw_csv = $2 WHERE id = $1`, [e.id, e.text]);
      for (const e of reportEdits) {
        await q(`UPDATE inventory_reports SET csv_content = $2, defective_csv_blob = $3, row_count = $4, defective_row_count = $5 WHERE id = $1`,
          [e.id, e.csv, e.def, e.rows, e.defRows]);
      }
      // Nothing of the 18 left in the places above.
      const left = (await q(`SELECT
          (SELECT count(*) FROM items WHERE epc = ANY($1))
        + (SELECT count(*) FROM inventory_audit_logs WHERE entity_reference = ANY($1))
        + (SELECT count(*) FROM device_epc_queue WHERE epc = ANY($1))
        + (SELECT count(*) FROM add_on_session_epcs WHERE epc = ANY($1))
        + (SELECT count(*) FROM add_on_sessions WHERE epc_ledger ?| $1)
        + (SELECT count(*) FROM cycle_count_sessions WHERE expected_snapshot::text ~ $2 OR scanned_epcs::text ~ $2 OR scanned_epc_sources::text ~ $2)
        + (SELECT count(*) FROM device_upload_logs WHERE raw_csv ~ $2)
        + (SELECT count(*) FROM inventory_reports WHERE csv_content ~ $2 OR defective_csv_blob ~ $2)
        + (SELECT count(*) FROM add_on_session_events WHERE payload::text ~ $2) AS n`, [EPCS, PAT])).rows[0].n;
      if (Number(left) !== 0) throw new Error(`still found in ${left} place(s) — rolled back`);
    }
  }
  console.log(counts);
  if (!WRITE) {
    await client.query('ROLLBACK');
    console.log('DRY RUN — nothing changed');
  } else {
    await client.query('COMMIT');
    console.log(`DONE — backup ${path.relative(process.cwd(), BACKUP)}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
