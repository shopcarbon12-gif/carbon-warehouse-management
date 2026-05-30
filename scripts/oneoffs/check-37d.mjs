import pg from 'pg';
const NEW = ['F0A0B30E4F9B8F7000038D23','F0A0B30E4F9B9000000A191D','F0A0B30E4F9B9030000752C7','F0A0B30E4F9B8F8000078262','F0A0B30E4F9B96200007372D','F0A0B30E4F9B9D3000066BC0','F0A0B30E4F9C21D00008DBB5','F0A0B30E4F9BBE20000D4801','F0A0B30E4F9BB320000340BD','F0A0B30E4F9C19B0000677C5','F0A0B30E4F9C02C0000E4749'];
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:false});
await c.connect();
const cr = await c.query(`SELECT epc_hex, MIN(read_at) AS first_read, MAX(read_at) AS last_read, COUNT(*) AS n, COUNT(DISTINCT reader_id) AS n_readers, array_agg(DISTINCT reader_id::text) AS reader_ids FROM cdm_reads WHERE epc_hex=ANY($1) GROUP BY epc_hex ORDER BY epc_hex`, [NEW]);
console.log('cdm_reads sightings of the 11 NEW EPCs:');
for (const r of cr.rows) console.log(' ', r.epc_hex.slice(0,16), '| first', r.first_read?.toISOString?.()?.slice(11,23), '| last', r.last_read?.toISOString?.()?.slice(11,23), '| n', r.n, '| readers', r.n_readers);
console.log('\ntotal NEW EPCs with reader sightings:', cr.rows.length, '/ 11');

// Check what readers ingested at 12:27:51 (the moment the items.last_seen_at clusters)
const burst = await c.query(`SELECT reader_id::text, COUNT(*) AS n FROM cdm_reads WHERE read_at BETWEEN '2026-05-30T12:27:50Z' AND '2026-05-30T12:27:53Z' GROUP BY reader_id ORDER BY n DESC LIMIT 10`);
console.log('\nReaders active during the 12:27:51 burst window:');
for (const r of burst.rows) console.log(' ', r.reader_id, 'n=', r.n);
await c.end();
