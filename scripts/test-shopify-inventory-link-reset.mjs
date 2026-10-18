// Exercise the production UPDATE statements against an isolated local temp table.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
}
const connectionString = env.DATABASE_URL;
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(connectionString).hostname), 'Tests require a local database');
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query(`CREATE TEMP TABLE custom_skus (
    id uuid PRIMARY KEY, shopify_variant_id text, shopify_inventory_item_id text,
    shopify_qty_synced integer, shopify_qty_synced_at timestamptz, shopify_image_url text
  )`);
  const id = '00000000-0000-4000-8000-000000000001';
  for (const file of ['lib/server/shopify-publish.ts', 'lib/server/shopify-link.ts']) {
    const sql = fs.readFileSync(file, 'utf8').match(/`(UPDATE custom_skus\s+SET shopify_qty_synced[\s\S]*?WHERE id = \$1::uuid)`/)?.[1];
    assert.ok(sql, `${file}: inventory identity update found`);
    for (const next of ['old-inventory', 'new-inventory', null]) {
      await client.query('TRUNCATE custom_skus');
      await client.query(`INSERT INTO custom_skus VALUES ($1, 'old-variant', 'old-inventory', 15, '2026-09-27T00:00:00Z', NULL)`, [id]);
      await client.query(sql, file.includes('shopify-link') ? [id, 'new-variant', next, null] : [id, 'new-variant', next]);
      const row = (await client.query('SELECT * FROM custom_skus')).rows[0];
      const changed = next === 'new-inventory' || (next === null && file.includes('shopify-publish'));
      assert.equal(row.shopify_qty_synced, changed ? null : 15, `${file}: quantity marker for ${next}`);
      assert.equal(row.shopify_qty_synced_at === null, changed, `${file}: timestamp marker for ${next}`);
      assert.equal(row.shopify_inventory_item_id, next === null && file.includes('shopify-link') ? 'old-inventory' : next);
    }
  }
  console.log('PASS: publish and relink clear stale markers for changed inventory IDs, preserve unchanged IDs, and handle missing IDs (6 cases).');
} finally {
  await client.end();
}
