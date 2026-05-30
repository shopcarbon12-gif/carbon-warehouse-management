// Merge the operator's authoritative add-on count CSV into session #020's
// scanned_epcs + source map so the variance pipeline actually sees what
// they scanned. Session-level totals (coverage, matched, added-here,
// defective) are computed on read from scanned_epcs ∩ expected, so once
// the EPCs land in scanned_epcs the KPI tiles update automatically.
//
// Why this exists: the cycle-count session for 5/28 ran with a build of
// the mobile app that uploaded its add-on contribution to
// /api/reports/count-sessions ONLY — it never merged those EPCs back into
// cycle_count_sessions.scanned_epcs. So the operator scanned 13,340 EPCs,
// the report stored them, but the cycle-count session never saw them.
// This script reconciles that one-off.
import fs from 'node:fs';
import pg from 'pg';

const SESSION_ID = '0ef02094-892a-4f39-9563-649455c21627';
const CSV_PATH = '/tmp/add-on-count-020.csv';
const SOURCE_NAME = 'Add-On Count';

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 10) continue;
    const epc = cols[0].trim().toUpperCase();
    const ts = cols[9].trim();
    if (epc && ts) out.set(epc, ts);
  }
  return out;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  const csvMap = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  console.log(`CSV: ${csvMap.size} EPCs from add-on count`);

  const { rows: [cur] } = await client.query(
    `SELECT scanned_epcs, scanned_epc_sources FROM cycle_count_sessions WHERE id=$1`,
    [SESSION_ID],
  );
  const scannedSet = new Set((cur.scanned_epcs ?? []).map((e) => String(e).toUpperCase()));
  const sources = { ...(cur.scanned_epc_sources ?? {}) };
  console.log(`Pre-merge: scanned_epcs=${scannedSet.size}, source entries=${Object.keys(sources).length}`);

  // Merge: add any CSV EPC not already in the session, and tag every CSV EPC
  // (including any pre-existing overlap) as mobile/Add-On Count.
  let added = 0;
  let already = 0;
  for (const [epc, ts] of csvMap.entries()) {
    if (scannedSet.has(epc)) already += 1;
    else { scannedSet.add(epc); added += 1; }
    sources[epc] = { kind: 'mobile', name: SOURCE_NAME, ts };
  }
  console.log(`Merge: ${added} new EPCs appended, ${already} already in session, ${csvMap.size} tagged mobile/Add-On Count`);

  const newScannedEpcs = [...scannedSet];

  await client.query(
    `UPDATE cycle_count_sessions
        SET scanned_epcs = $2::jsonb,
            scanned_epc_sources = $3::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [SESSION_ID, JSON.stringify(newScannedEpcs), JSON.stringify(sources)],
  );

  // Verify post-state.
  const { rows: [post] } = await client.query(
    `SELECT
       jsonb_array_length(scanned_epcs) AS n_epcs,
       (SELECT count(*) FROM jsonb_each(scanned_epc_sources) WHERE value->>'kind' = 'mobile' AND value->>'name' = $2) AS add_on_count,
       (SELECT count(*) FROM jsonb_each(scanned_epc_sources) WHERE value->>'kind' = 'mobile' AND value->>'name' = 'mobile (pre-tracking)') AS pre_tracking,
       (SELECT count(*) FROM jsonb_each(scanned_epc_sources) WHERE value->>'kind' = 'reader') AS reader
     FROM cycle_count_sessions WHERE id=$1`,
    [SESSION_ID, SOURCE_NAME],
  );
  console.log('Post-merge totals:', post);
} finally {
  await client.end();
}
