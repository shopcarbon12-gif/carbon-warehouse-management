import pg from 'pg';
const NEW = ['F0A0B30E4F9B8F7000038D23','F0A0B30E4F9B9000000A191D','F0A0B30E4F9B9030000752C7','F0A0B30E4F9B8F8000078262','F0A0B30E4F9B96200007372D','F0A0B30E4F9B9D3000066BC0','F0A0B30E4F9C21D00008DBB5','F0A0B30E4F9BBE20000D4801','F0A0B30E4F9BB320000340BD','F0A0B30E4F9C19B0000677C5','F0A0B30E4F9C02C0000E4749'];
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:false});
await c.connect();
console.log('=== encode_events for the 11 new EPCs ===');
const ee = await c.query(`SELECT new_epc, status, encoded_at FROM encode_events WHERE new_epc=ANY($1) ORDER BY encoded_at`, [NEW]);
for (const r of ee.rows) console.log(' ', r.new_epc.slice(0,16), '|', r.status, '|', r.encoded_at?.toISOString?.());

console.log('\n=== cdm_reads sightings of new EPCs ===');
const cr = await c.query(`SELECT epc, MIN(read_at) as first_read, MAX(read_at) as last_read, COUNT(*) as n, COUNT(DISTINCT reader_id) as n_readers FROM cdm_reads WHERE epc=ANY($1) GROUP BY epc ORDER BY epc`, [NEW]);
for (const r of cr.rows) console.log(' ', r.epc.slice(0,16), '| first', r.first_read?.toISOString?.(), '| last', r.last_read?.toISOString?.(), '| reads', r.n, '| readers', r.n_readers);

console.log('\n=== items rows full state ===');
const it = await c.query(`SELECT epc, status, created_at, last_seen_at, source FROM items WHERE epc=ANY($1) ORDER BY epc`, [NEW]);
for (const r of it.rows) console.log(' ', r.epc.slice(0,16), '|', r.status, '| src', r.source, '| created', r.created_at?.toISOString?.(), '| last_seen', r.last_seen_at?.toISOString?.());
await c.end();
