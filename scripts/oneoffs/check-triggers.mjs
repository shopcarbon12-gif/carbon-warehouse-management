import pg from 'pg';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:false});
await c.connect();
const tr = await c.query(`SELECT trigger_name, event_manipulation, action_timing, action_statement FROM information_schema.triggers WHERE event_object_table='items' ORDER BY trigger_name`);
console.log('Triggers on items:');
for (const r of tr.rows) console.log(' ', r.trigger_name, '|', r.event_manipulation, '|', r.action_timing, '|', r.action_statement?.slice(0,140));

// Also check for any function definition that sets last_seen_at
const fns = await c.query(`SELECT proname, prosrc FROM pg_proc WHERE prosrc ILIKE '%last_seen_at%' AND prosrc ILIKE '%items%'`);
console.log('\nFunctions touching items.last_seen_at:');
for (const r of fns.rows) console.log(' fn=', r.proname, '\n   src:', r.prosrc.slice(0,400));
await c.end();
