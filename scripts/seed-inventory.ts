/**
 * Seeds one Matrix + Custom SKUs + bins + in-stock EPCs for UI testing.
 * Targets location code `003` (Elementi Florida Mall). Run after migrations (matrices / custom_skus).
 *
 *   npx tsx scripts/seed-inventory.ts
 */
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { generateSGTIN96 } from "../lib/utils/epc";

loadEnvConfig(process.cwd());

const COMPANY_PREFIX = 1044991;

const MATRIX_UPC = "1122205";
const MATRIX_DESCRIPTION = "Stringer Pride Tank Top";

const LOCATION_CODE = "003";
const LOCATION_NAME_SUBSTR = "Elementi Florida Mall";

const BIN_MIXED = "1A-01-C";
const BIN_LEFT = "1A-01-L";

const SKU_BLACK_L = {
  sku: "112220507L",
  ls_system_id: 8675309,
  /** Lightspeed color code */
  color_code: "07",
  size: "L",
  serials: [1, 2, 3, 4, 5] as const,
};

const SKU_WHITE_M = {
  sku: "112220511M",
  ls_system_id: 8675310,
  color_code: "11",
  size: "M",
  serials: [1, 2, 3] as const,
};

function requireDatabaseUrl(): string {
  const u = process.env.DATABASE_URL?.trim();
  if (!u) {
    console.error("DATABASE_URL is required (copy .env.example to .env).");
    throw new Error("DATABASE_URL is required");
  }
  return u;
}

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const loc = await client.query<{ id: string }>(
      `SELECT id FROM locations
       WHERE code = $1 AND name ILIKE $2
       LIMIT 1`,
      [LOCATION_CODE, `%${LOCATION_NAME_SUBSTR}%`],
    );
    const locationId = loc.rows[0]?.id;
    if (!locationId) {
      throw new Error(
        `Location not found: code=${LOCATION_CODE} name~=${LOCATION_NAME_SUBSTR}. Run npm run db:seed first.`,
      );
    }

    await client.query(
      `INSERT INTO bins (location_id, code)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT (location_id, code) DO NOTHING`,
      [locationId, BIN_MIXED, BIN_LEFT],
    );

    const bins = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM bins
       WHERE location_id = $1::uuid AND code IN ($2, $3)`,
      [locationId, BIN_MIXED, BIN_LEFT],
    );
    const binC = bins.rows.find((b) => b.code === BIN_MIXED);
    const binL = bins.rows.find((b) => b.code === BIN_LEFT);
    if (!binC || !binL) {
      throw new Error("Failed to resolve bin rows after insert");
    }

    const matrixIns = await client.query<{ id: string }>(
      `INSERT INTO matrices (upc, description)
       VALUES ($1, $2)
       ON CONFLICT (upc) DO UPDATE
         SET description = EXCLUDED.description
       RETURNING id`,
      [MATRIX_UPC, MATRIX_DESCRIPTION],
    );
    let mid = matrixIns.rows[0]?.id;
    if (!mid) {
      const sel = await client.query<{ id: string }>(
        `SELECT id FROM matrices WHERE upc = $1 LIMIT 1`,
        [MATRIX_UPC],
      );
      mid = sel.rows[0]?.id;
    }
    if (!mid) throw new Error("Failed to resolve matrix id");

    await client.query(
      `INSERT INTO custom_skus (matrix_id, sku, ls_system_id, color_code, size)
       VALUES
         ($1::uuid, $2, $3, $4, $5),
         ($1::uuid, $6, $7, $8, $9)
       ON CONFLICT (sku) DO UPDATE SET
         matrix_id = EXCLUDED.matrix_id,
         ls_system_id = EXCLUDED.ls_system_id,
         color_code = EXCLUDED.color_code,
         size = EXCLUDED.size`,
      [
        mid,
        SKU_BLACK_L.sku,
        SKU_BLACK_L.ls_system_id,
        SKU_BLACK_L.color_code,
        SKU_BLACK_L.size,
        SKU_WHITE_M.sku,
        SKU_WHITE_M.ls_system_id,
        SKU_WHITE_M.color_code,
        SKU_WHITE_M.size,
      ],
    );

    const skus = await client.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM custom_skus WHERE sku IN ($1, $2)`,
      [SKU_BLACK_L.sku, SKU_WHITE_M.sku],
    );
    const idBlack = skus.rows.find((r) => r.sku === SKU_BLACK_L.sku)?.id;
    const idWhite = skus.rows.find((r) => r.sku === SKU_WHITE_M.sku)?.id;
    if (!idBlack || !idWhite) {
      throw new Error("Failed to resolve custom_sku ids");
    }

    await client.query(
      `DELETE FROM items i
       USING custom_skus cs
       WHERE i.custom_sku_id = cs.id
         AND i.location_id = $1::uuid
         AND cs.sku = ANY($2::text[])`,
      [locationId, [SKU_BLACK_L.sku, SKU_WHITE_M.sku]],
    );

    let inserted = 0;
    for (const sn of SKU_BLACK_L.serials) {
      const epc = generateSGTIN96(
        COMPANY_PREFIX,
        SKU_BLACK_L.ls_system_id,
        sn,
      );
      await client.query(
        `INSERT INTO items (epc, serial_number, custom_sku_id, location_id, bin_id, status)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'in-stock')`,
        [epc, sn, idBlack, locationId, binC.id],
      );
      inserted += 1;
    }
    for (const sn of SKU_WHITE_M.serials) {
      const epc = generateSGTIN96(
        COMPANY_PREFIX,
        SKU_WHITE_M.ls_system_id,
        sn,
      );
      await client.query(
        `INSERT INTO items (epc, serial_number, custom_sku_id, location_id, bin_id, status)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'in-stock')`,
        [epc, sn, idWhite, locationId, binC.id],
      );
      inserted += 1;
    }

    await client.query("COMMIT");

    console.log("seed-inventory: OK");
    console.log("  Location:", LOCATION_CODE, locationId);
    console.log("  Matrix:", MATRIX_UPC, mid);
    console.log("  Bins:", BIN_MIXED, "(mixed)", binC.id, ";", BIN_LEFT, "(empty)", binL.id);
    console.log("  Items inserted:", inserted, "(5 Black/L + 3 White/M in", BIN_MIXED + ")");
    console.log("  Company prefix (SGTIN):", COMPANY_PREFIX);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  const refused = (e as { code?: string })?.code === "ECONNREFUSED";
  if (refused) {
    console.error(
      "Postgres refused the connection. Start local DB: docker compose up -d",
    );
  }
  if ((e as { message?: string })?.message?.includes("matrices")) {
    console.error("Hint: run npm run db:migrate (003 renames products → matrices).");
  }
  console.error(e);
  process.exit(1);
});
