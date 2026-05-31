// Undo session-020-merge-mobile-epcs.mjs. Removes the 13,340 add-on EPCs
// from scanned_epcs and drops their mobile/Add-On Count source entries,
// returning the session to its pre-merge state (10,253 scanned EPCs +
// 6,523 reader / 3,730 mobile (pre-tracking) source entries).
//
// CSV at /tmp/add-on-count-020.csv defines the EPC set to remove.
import fs from 'node:fs';
import pg from 'pg';

const SESSION_ID = '0ef02094-892a-4f39-9563-649455c21627';
const CSV_PATH = '/tmp/add-on-count-020.csv';

function csvEpcs() {
  const out = new Set();
  for (const line of fs.readFileSync(CSV_PATH, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    out.add(line.split(',')[0].trim().toUpperCase());
  }
  return out;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  const toRemove = csvEpcs();
  console.log(`CSV defines ${toRemove.size} EPCs to remove`);

  const { rows: [cur] } = await client.query(
    `SELECT scanned_epcs, scanned_epc_sources FROM cycle_count_sessions WHERE id=$1`,
    [SESSION_ID],
  );
  console.log(`Pre-rollback: scanned_epcs=${cur.scanned_epcs.length}, sources=${Object.keys(cur.scanned_epc_sources ?? {}).length}`);

  const newScanned = cur.scanned_epcs
    .map((e) => String(e).toUpperCase())
    .filter((e) => !toRemove.has(e));
  const newSources = { ...(cur.scanned_epc_sources ?? {}) };
  for (const epc of toRemove) delete newSources[epc];

  await client.query(
    `UPDATE cycle_count_sessions
        SET scanned_epcs = $2::jsonb,
            scanned_epc_sources = $3::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [SESSION_ID, JSON.stringify(newScanned), JSON.stringify(newSources)],
  );

  const { rows: [after] } = await client.query(
    `SELECT jsonb_array_length(scanned_epcs) AS n_epcs,
            (SELECT count(*) FROM jsonb_each(scanned_epc_sources)) AS n_sources
       FROM cycle_count_sessions WHERE id=$1`,
    [SESSION_ID],
  );
  console.log('Post-rollback:', after);
} finally {
  await client.end();
}
