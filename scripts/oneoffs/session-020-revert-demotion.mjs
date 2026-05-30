// Undo the over-eager "demote mobile (pre-tracking) → reader/unattributed"
// step from session-020-mobile-attribution.mjs. The 'reader/unattributed'
// label doesn't exist anywhere else in the data model — every entry with
// that exact pairing was created by my earlier run and should be restored
// to its prior "mobile (pre-tracking)" attribution from migration 045.
import pg from 'pg';

const SESSION_ID = '0ef02094-892a-4f39-9563-649455c21627';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  const { rows: [cur] } = await client.query(
    `SELECT scanned_epc_sources FROM cycle_count_sessions WHERE id=$1`, [SESSION_ID]
  );
  const src = { ...(cur.scanned_epc_sources ?? {}) };
  let restored = 0;
  for (const epc of Object.keys(src)) {
    const e = src[epc];
    if (e?.kind === 'reader' && e?.name === 'unattributed') {
      src[epc] = { kind: 'mobile', name: 'mobile (pre-tracking)', ts: e.ts };
      restored += 1;
    }
  }
  console.log(`Restoring ${restored} entries from reader/unattributed → mobile (pre-tracking)`);
  await client.query(
    `UPDATE cycle_count_sessions SET scanned_epc_sources=$2::jsonb, updated_at=now() WHERE id=$1`,
    [SESSION_ID, JSON.stringify(src)],
  );
  const { rows: [after] } = await client.query(
    `SELECT
       (SELECT count(*) FROM jsonb_each(scanned_epc_sources) WHERE value->>'kind' = 'mobile') AS mobile,
       (SELECT count(*) FROM jsonb_each(scanned_epc_sources) WHERE value->>'kind' = 'reader') AS reader
     FROM cycle_count_sessions WHERE id=$1`, [SESSION_ID]
  );
  console.log('Post-restore:', after);
} finally {
  await client.end();
}
