// Owner, 2026-10-16: "CANCEL Count 029 report AS THE LATEST INVENTORY COUNT WAS
// IN THE MOBILE APP" (M-69090 + its Add-On, uploaded 2026-10-15 01:39).
//   - Cycle Count #029 (committed 2026-10-13) → canceled: no longer offered as
//     an Add-On source or treated as a current count. Stock is NOT changed —
//     whatever its commit did stays as it is.
//   - Its Add-On session C-029 (paused since 2026-10-13, 13,817 tags — where
//     five of the 2026-10-13 phantoms came from) → cancelled, so its ledger can
//     never be resumed and uploaded again; the source lock is released and the
//     cancel is logged as a session event.
// Writes both rows to docs/rfid/evidence first.
//
//   DATABASE_URL=… node scripts/oneoffs/cancel-count-029-2026-10-16.mjs           # dry run
//   DATABASE_URL=… node scripts/oneoffs/cancel-count-029-2026-10-16.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const WRITE = process.argv.includes('--write');
const BACKUP = path.resolve('docs/rfid/evidence/cancel-count-029-backup-2026-10-16.json');
const ADD_ON_ID = '672c0e37-0404-4893-bcd0-7d9c139d1660';
const REASON = 'owner 2026-10-16: the latest inventory count was in the mobile app (M-69090)';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await client.connect();
try {
  await client.query('BEGIN');
  const count = (await client.query(
    `SELECT id::text, tenant_id::text, session_number, status, completed_at, add_on_locked_by::text
       FROM cycle_count_sessions WHERE session_number = 29 FOR UPDATE`,
  )).rows;
  const addOn = (await client.query(
    `SELECT id::text, tenant_id::text, source_type, source_id::text, source_slip, state, epc_count, started_at, last_activity_at
       FROM add_on_sessions WHERE id = $1::uuid FOR UPDATE`,
    [ADD_ON_ID],
  )).rows;
  const c = count[0], a = addOn[0];
  if (count.length !== 1 || c.status !== 'committed') throw new Error(`Count 029: expected one committed session, got ${JSON.stringify(count)}`);
  if (!a || a.state !== 'paused' || a.source_slip !== 'C-029' || a.source_id !== c.id) throw new Error(`Add-On C-029: expected the paused session on count 029, got ${JSON.stringify(a)}`);
  console.log(`Count #029 ${c.id}: ${c.status} → canceled`);
  console.log(`Add-On ${a.id} (${a.source_slip}, ${a.epc_count} tags): ${a.state} → cancelled`);
  if (!WRITE) {
    await client.query('ROLLBACK');
    console.log('DRY RUN — nothing changed');
  } else {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
    fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), count: c, addOn: a }, null, 1));
    await client.query(
      `UPDATE cycle_count_sessions SET status = 'canceled', add_on_locked_by = NULL, updated_at = now(),
              notes = concat_ws(E'\\n', NULLIF(notes, ''), $2::text)
        WHERE id = $1::uuid AND status = 'committed'`,
      [c.id, `Canceled ${new Date().toISOString().slice(0, 10)} — ${REASON}`],
    );
    await client.query(
      `UPDATE add_on_sessions SET state = 'cancelled', ended_at = now() WHERE id = $1::uuid AND state = 'paused'`,
      [a.id],
    );
    await client.query(
      `INSERT INTO add_on_session_events (session_id, tenant_id, user_id, device_id, event_type, payload)
       VALUES ($1::uuid, $2::uuid, NULL, NULL, 'cancelled', $3::jsonb)`,
      [a.id, a.tenant_id, JSON.stringify({ reason: REASON })],
    );
    await client.query('COMMIT');
    console.log(`done; backup ${path.relative(process.cwd(), BACKUP)}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
