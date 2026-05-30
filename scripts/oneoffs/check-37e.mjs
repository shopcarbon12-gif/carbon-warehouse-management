import pg from 'pg';
const NEW = ['F0A0B30E4F9B8F7000038D23','F0A0B30E4F9B9000000A191D','F0A0B30E4F9B9030000752C7','F0A0B30E4F9B8F8000078262','F0A0B30E4F9B96200007372D','F0A0B30E4F9B9D3000066BC0','F0A0B30E4F9C21D00008DBB5','F0A0B30E4F9BBE20000D4801','F0A0B30E4F9BB320000340BD','F0A0B30E4F9C19B0000677C5','F0A0B30E4F9C02C0000E4749'];
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:false});
await c.connect();

// How many OTHER items got incorrectly promoted by the bulk SKU update?
// SKUs from upload-37
const SKUS = ['C126319505711','C126319635711','C126319665711','C126319515711','C11171057C233','C11171071C234','C216316371144','C125214250342','C12171520C201','C126116021137','C111113501130'];
const allHit = await c.query(`
  SELECT cs.sku, COUNT(*) FILTER (WHERE i.status='in-stock') AS in_stock, COUNT(*) AS total
  FROM items i JOIN custom_skus cs ON i.custom_sku_id=cs.id
  WHERE cs.sku=ANY($1)
  GROUP BY cs.sku ORDER BY cs.sku`, [SKUS]);
console.log('Items per SKU from upload-37:');
for (const r of allHit.rows) console.log(' ', r.sku, '| in-stock', r.in_stock, '/ total', r.total);

// How many items got last_seen_at bumped within the upload window (12:27:30-12:28:30)?
const window = await c.query(`
  SELECT COUNT(*) AS n
  FROM items i JOIN custom_skus cs ON i.custom_sku_id=cs.id
  WHERE cs.sku=ANY($1)
    AND i.last_seen_at BETWEEN '2026-05-30T12:27:30Z' AND '2026-05-30T12:28:30Z'`, [SKUS]);
console.log('\nItems with last_seen_at in upload-37 window:', window.rows[0].n);

await c.end();
