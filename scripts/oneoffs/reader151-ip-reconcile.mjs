import pg from 'pg';

const READER_ID = 'b25dd931-411c-4421-80e7-cf0c16514c26';
const mode = process.argv[2] || 'show';            // 'show' | 'update'
const newIp = process.argv[3] || '192.168.1.15';

const client = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 15432),
  user: 'postgres',
  password: '3H5ouoNVVMvUyFweIwpH50KiJwfkFLin6wJjyMg49RIEv6UTKJZqo1QFYSpez6g1',
  database: 'postgres', ssl: false,
});

await client.connect();
if (mode === 'cols') {
  const cols = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='devices' ORDER BY ordinal_position",
  );
  console.log('COLUMNS:', cols.rows.map((r) => r.column_name).join(', '));
  await client.end();
  process.exit(0);
}
if (mode === 'find') {
  const r = await client.query(
    `SELECT id, name, network_address, mac_address, config->>'uuid' AS cfg_uuid
       FROM devices
      WHERE name ILIKE '%6/2%'
         OR network_address IN ('192.168.1.151','192.168.1.15')
         OR mac_address ILIKE '%1E1980%'
         OR config->>'uuid' = $1`,
    [READER_ID],
  );
  console.log('MATCHES:', JSON.stringify(r.rows, null, 2));
  await client.end();
  process.exit(0);
}
const before = await client.query(
  'SELECT id, name, network_address, mac_address FROM devices WHERE id = $1',
  [READER_ID],
);
console.log('BEFORE:', JSON.stringify(before.rows[0] ?? 'NOT FOUND'));

if (mode === 'update' && before.rows[0]) {
  const res = await client.query(
    'UPDATE devices SET network_address = $1 WHERE id = $2 RETURNING id, name, network_address',
    [newIp, READER_ID],
  );
  console.log('UPDATED:', JSON.stringify(res.rows[0]));
}
await client.end();
