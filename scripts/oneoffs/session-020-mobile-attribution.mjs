// One-shot: overwrite cycle_count_sessions.scanned_epc_sources for session #020
// with the authoritative add-on count CSV the operator uploaded on 2026-05-30.
//
// What this does:
//   1. Reads /tmp/add-on-count-020.csv (epc + first_seen_iso) — the real list
//      of EPCs the operator scanned via the mobile add-on screen.
//   2. For every EPC in the CSV, sets the source entry to
//      {kind: 'mobile', name: 'Add-On Count', ts: <first_seen_iso>}.
//      This OVERRIDES whatever was there (including misattributed
//      "mobile (pre-tracking)" rows from migration 045's catch-all bucket).
//   3. For every EPC in the session that is NOT in the CSV and is currently
//      tagged "mobile (pre-tracking)" OR "mobile (Add-On Count)", demotes
//      it to {kind: 'reader', name: 'unattributed'} so the chip strip stops
//      claiming the operator scanned 3,602 things via the handheld when
//      they actually scanned ~6.4k different things.
//   4. Reader-attributed entries (Aisle 3-4/1, POS, etc.) are left alone —
//      those came from real cdm_reads joins and are still correct.
//
// Run:
//   cd /home/carbondev/dev/carbon-warehouse-management
//   node --env-file=.env.coolify.local scripts/oneoffs/session-020-mobile-attribution.mjs

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const SESSION_ID = '0ef02094-892a-4f39-9563-649455c21627';
const CSV_PATH = '/tmp/add-on-count-020.csv';
const SOURCE_NAME = 'Add-On Count';

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // header: epc,system_id,custom_sku,item_name,color,size,retail_price,bin,seen_count,first_seen_iso,last_seen_iso
  const out = new Map(); // upper(epc) -> ts
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 10) continue;
    const epc = cols[0].trim().toUpperCase();
    const firstSeen = cols[9].trim();
    if (!epc || !firstSeen) continue;
    out.set(epc, firstSeen);
  }
  return out;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set. Run with --env-file=.env.coolify.local');
    process.exit(1);
  }

  console.log(`Reading CSV: ${CSV_PATH}`);
  const csvRaw = fs.readFileSync(CSV_PATH, 'utf8');
  const csvMap = parseCsv(csvRaw);
  console.log(`Parsed ${csvMap.size} EPCs from add-on count CSV.`);

  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  console.log('Connected to prod DB.');

  try {
    // 1. Fetch current state.
    const cur = await client.query(
      `SELECT scanned_epcs, scanned_epc_sources
         FROM cycle_count_sessions
        WHERE id = $1`,
      [SESSION_ID],
    );
    if (cur.rows.length === 0) throw new Error(`session ${SESSION_ID} not found`);
    const { scanned_epcs: scannedEpcs, scanned_epc_sources: oldSources } = cur.rows[0];
    const sources = { ...(oldSources ?? {}) };

    console.log(
      `Current session: ${scannedEpcs.length} scanned EPCs, ${Object.keys(sources).length} source entries.`,
    );

    // Build the canonical "what's in the session" set. The source map MUST
    // be a subset of this — keys outside it are dead weight from the prior
    // bad run and need to be dropped.
    const scannedSet = new Set(
      (scannedEpcs ?? []).map((e) => String(e).toUpperCase()),
    );

    // 1. Drop any source entry whose EPC isn't in scanned_epcs.
    //    (Cleans up the over-application from the previous run.)
    let orphans = 0;
    for (const epc of Object.keys(sources)) {
      if (!scannedSet.has(epc)) {
        delete sources[epc];
        orphans += 1;
      }
    }

    // 2. For every EPC that's BOTH in the CSV and in the session, set
    //    mobile/Add-On Count attribution. EPCs in the CSV but not in the
    //    session are out-of-scope (operator scanned them but the commit
    //    didn't include them).
    let added = 0;
    let overrode = 0;
    let outOfScope = 0;
    for (const [epc, ts] of csvMap.entries()) {
      if (!scannedSet.has(epc)) { outOfScope += 1; continue; }
      const prev = sources[epc];
      if (!prev) added += 1;
      else if (prev.kind !== 'mobile' || prev.name !== SOURCE_NAME) overrode += 1;
      sources[epc] = { kind: 'mobile', name: SOURCE_NAME, ts };
    }

    // 3. Demote stale mobile-named buckets for session EPCs that AREN'T
    //    in the CSV. Those came from migration 045's catch-all and shouldn't
    //    keep claiming mobile attribution.
    let demoted = 0;
    for (const epc of Object.keys(sources)) {
      if (csvMap.has(epc)) continue;
      const entry = sources[epc];
      if (!entry || entry.kind !== 'mobile') continue;
      sources[epc] = { kind: 'reader', name: 'unattributed', ts: entry.ts };
      demoted += 1;
    }

    // 4. Diff summary.
    const finalMobile = Object.values(sources).filter((s) => s?.kind === 'mobile').length;
    const finalReaderAttr = Object.values(sources).filter(
      (s) => s?.kind === 'reader' && s?.name !== 'unattributed',
    ).length;
    const finalUnattr = Object.values(sources).filter(
      (s) => s?.kind === 'reader' && s?.name === 'unattributed',
    ).length;
    console.log('--- PLANNED CHANGES ---');
    console.log(`  Orphan source entries dropped: ${orphans}`);
    console.log(`  Mobile/Add-On Count set: ${added + overrode} (added: ${added}, overrode: ${overrode})`);
    console.log(`  Mobile CSV EPCs not in session: ${outOfScope}`);
    console.log(`  Demoted stale mobile→unattributed: ${demoted}`);
    console.log('--- POST-WRITE TOTALS ---');
    console.log(`  mobile entries:       ${finalMobile}`);
    console.log(`  reader (named):       ${finalReaderAttr}`);
    console.log(`  reader (unattributed):${finalUnattr}`);

    // 5. Commit.
    const upd = await client.query(
      `UPDATE cycle_count_sessions
          SET scanned_epc_sources = $2::jsonb,
              updated_at          = now()
        WHERE id = $1
       RETURNING id`,
      [SESSION_ID, JSON.stringify(sources)],
    );
    console.log(`UPDATE OK: ${upd.rows.length} row`);

    // 6. Sanity check — re-read.
    const after = await client.query(
      `SELECT
         (SELECT count(*) FROM jsonb_each(scanned_epc_sources) WHERE value->>'kind' = 'mobile') AS mobile_count,
         (SELECT count(*) FROM jsonb_each(scanned_epc_sources)
           WHERE value->>'kind' = 'mobile' AND value->>'name' = 'mobile (pre-tracking)') AS pre_tracking_count,
         (SELECT count(*) FROM jsonb_each(scanned_epc_sources)
           WHERE value->>'kind' = 'mobile' AND value->>'name' = $2) AS add_on_count
       FROM cycle_count_sessions WHERE id = $1`,
      [SESSION_ID, SOURCE_NAME],
    );
    console.log('Verify:', after.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
