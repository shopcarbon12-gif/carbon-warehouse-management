#!/usr/bin/env node
/**
 * One-shot demo seed: inserts a small set of "items" matching the EPCs the
 * Carbon CDM agent's mock-monsoon binary emits, so they show up in the
 * Transfers page when the agent streams reads.
 *
 * Idempotent — safe to re-run. Only inserts what's missing.
 *
 *   npm run seed:cdm-demo   (or: node scripts/seed-cdm-demo-items.mjs)
 */
import pg from "pg";

const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/carbon_wms";

// Must match the EPCs that mock-monsoon.mjs generates (pool of 8).
function buildMockPool(epcPrefix = "f0a0b30e", size = 8) {
  return Array.from({ length: size }, (_, i) => {
    const suffix = `4f9c${(0xb000 + i).toString(16).padStart(4, "0")}0001${(
      0x8000 + i
    )
      .toString(16)
      .padStart(4, "0")}`;
    return ((epcPrefix + suffix).padEnd(24, "0").slice(0, 24)).toUpperCase();
  });
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query("BEGIN");

  const t = await c.query(`SELECT id::text FROM tenants WHERE slug='cj' LIMIT 1`);
  if (!t.rows[0]) throw new Error("tenant 'cj' not found — run db:migrate first");
  const tenantId = t.rows[0].id;

  const l = await c.query(
    `SELECT id::text FROM locations WHERE tenant_id=$1::uuid AND code='001' LIMIT 1`,
    [tenantId],
  );
  if (!l.rows[0]) throw new Error("location 001 not found");
  const locationId = l.rows[0].id;

  // Matrix
  let m = await c.query(
    `SELECT id::text FROM matrices WHERE description=$1 AND brand=$2 LIMIT 1`,
    ["Carbon CDM Demo Item", "CARBON"],
  );
  let matrixId = m.rows[0]?.id;
  if (!matrixId) {
    const ins = await c.query(
      `INSERT INTO matrices (description, brand, vendor)
       VALUES ('Carbon CDM Demo Item', 'CARBON', 'CARBON')
       RETURNING id::text`,
    );
    matrixId = ins.rows[0].id;
    console.log("created matrix", matrixId);
  } else {
    console.log("reusing matrix", matrixId);
  }

  // Custom SKU
  let cs = await c.query(
    `SELECT id::text FROM custom_skus WHERE sku=$1 AND matrix_id=$2::uuid LIMIT 1`,
    ["CDM-DEMO", matrixId],
  );
  let skuId = cs.rows[0]?.id;
  if (!skuId) {
    // ls_system_id is NOT NULL but should be unique-ish; use timestamp.
    const ins = await c.query(
      `INSERT INTO custom_skus (matrix_id, sku, ls_system_id, asset_id)
       VALUES ($1::uuid, 'CDM-DEMO', $2::bigint, 'CDM-DEMO-ASSET')
       RETURNING id::text`,
      [matrixId, Math.floor(Date.now() / 1000)],
    );
    skuId = ins.rows[0].id;
    console.log("created custom_sku", skuId);
  } else {
    console.log("reusing custom_sku", skuId);
  }

  // Items (8 EPCs)
  const epcs = buildMockPool();
  let inserted = 0;
  let existed = 0;
  for (let i = 0; i < epcs.length; i++) {
    const epc = epcs[i];
    const exists = await c.query(`SELECT 1 FROM items WHERE epc=$1 LIMIT 1`, [epc]);
    if (exists.rowCount && exists.rowCount > 0) {
      existed++;
      continue;
    }
    await c.query(
      `INSERT INTO items (epc, serial_number, custom_sku_id, location_id, status)
       VALUES ($1, $2, $3::uuid, $4::uuid, 'in-stock')`,
      [epc, 9_000_000 + i, skuId, locationId],
    );
    inserted++;
  }
  console.log(`items: ${inserted} inserted, ${existed} already existed`);

  await c.query("COMMIT");
  console.log("done");
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await c.end();
}
