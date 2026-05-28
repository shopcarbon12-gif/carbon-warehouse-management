/**
 * One-shot importer for the Lightspeed item_listings extract that introduces
 * three previously-unmodeled catalog fields:
 *
 *   - custom_skus.default_cost   (variant unit cost, NUMERIC(12,4))
 *   - matrices.category          (matrix tag, varchar(128))   — column existed
 *   - matrices.subcategory_1     (matrix tag, varchar(128))   — added in 0085
 *
 * CSV shape:
 *   System ID, UPC, Custom SKU, Item, Default Cost, Category, Subcategory 1
 *
 * Match key:
 *   1) custom_skus.ls_system_id = CSV "System ID"
 *   2) Fallback: custom_skus.sku = CSV "Custom SKU"
 *
 * Strategy:
 *   - Stage the CSV into a TEMP TABLE.
 *   - Resolve each CSV row to a custom_sku_id, recording which key matched.
 *   - Update custom_skus.default_cost in one shot.
 *   - Update each parent matrix's category/subcategory_1 (last-write-wins
 *     across multiple variants — fine because the CSV is matrix-consistent).
 *   - All in one transaction. Idempotent: re-runs are safe.
 *
 *   node scripts/import-catalog-cost-category.mjs            # prod (.env.coolify.local)
 *   DRY_RUN=1 node scripts/import-catalog-cost-category.mjs  # report-only, no writes
 *   CSV_PATH=/abs/path/to/file.csv node scripts/...mjs       # override default path
 *
 * Default CSV path is the file dropped at the top of the synced Dropbox tree.
 */
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const DEFAULT_CSV =
  "/home/carbondev/CARBON JEANS COMPANY Dropbox/elior perez/item_listings_local_matches (2).csv";
const CSV_PATH = process.env.CSV_PATH || DEFAULT_CSV;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function loadEnvFile(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return;
  let text = fs.readFileSync(p, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (key !== "DATABASE_URL" || process.env.DATABASE_URL) continue;
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env.DATABASE_URL = val;
  }
}

if (!process.env.DATABASE_URL) loadEnvFile(".env.coolify.local");
if (!process.env.DATABASE_URL) loadEnvFile(".env.local");
if (!process.env.DATABASE_URL) loadEnvFile(".env");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("Set DATABASE_URL or add it to .env.coolify.local");
  process.exit(1);
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV not found: ${CSV_PATH}`);
  process.exit(1);
}

// Tiny RFC4180-ish CSV parser. The file in hand has no embedded quotes or
// commas in fields, but we keep this defensive in case Lightspeed re-exports
// with quoting later.
function parseCsv(text) {
  const rows = [];
  let i = 0;
  let cur = "";
  let row = [];
  let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

const raw = fs.readFileSync(CSV_PATH, "utf8");
const parsed = parseCsv(raw).filter((r) => r.length > 0 && r.some((c) => c !== ""));
if (parsed.length < 2) {
  console.error("CSV has no data rows");
  process.exit(1);
}

const header = parsed[0].map((h) => h.trim());
const idx = {
  systemId: header.indexOf("System ID"),
  upc: header.indexOf("UPC"),
  customSku: header.indexOf("Custom SKU"),
  item: header.indexOf("Item"),
  defaultCost: header.indexOf("Default Cost"),
  category: header.indexOf("Category"),
  subcategory1: header.indexOf("Subcategory 1"),
};
for (const [k, v] of Object.entries(idx)) {
  if (v < 0) {
    console.error(`Missing required column: ${k} (header had: ${header.join(" | ")})`);
    process.exit(1);
  }
}

const dataRows = parsed.slice(1).map((r) => ({
  systemId: (r[idx.systemId] ?? "").trim(),
  customSku: (r[idx.customSku] ?? "").trim(),
  defaultCost: (r[idx.defaultCost] ?? "").trim(),
  category: (r[idx.category] ?? "").trim() || null,
  subcategory1: (r[idx.subcategory1] ?? "").trim() || null,
}));

console.log(`CSV: ${CSV_PATH}`);
console.log(`Rows parsed (excl. header): ${dataRows.length}`);
if (DRY_RUN) console.log("DRY_RUN=1 — no writes will be issued.");
console.log("Target host:", new URL(url.replace(/^postgresql:/, "http:")).hostname);

const pool = new pg.Pool({ connectionString: url, max: 4 });
const client = await pool.connect();

try {
  await client.query("BEGIN");

  // Stage the CSV into a TEMP TABLE for set-based resolution.
  await client.query(`
    CREATE TEMP TABLE staging_catalog_csv (
      row_no       integer,
      system_id    text,
      custom_sku   text,
      default_cost numeric(12, 4),
      category     varchar(128),
      subcategory_1 varchar(128)
    ) ON COMMIT DROP
  `);

  // Build a multi-row INSERT in chunks (1000 rows / pass keeps under
  // Postgres parameter limits with 6 cols × 1000 = 6000 params, well
  // below the 65535 cap).
  const CHUNK = 1000;
  for (let off = 0; off < dataRows.length; off += CHUNK) {
    const slice = dataRows.slice(off, off + CHUNK);
    const values = [];
    const params = [];
    let p = 1;
    for (let i = 0; i < slice.length; i += 1) {
      const r = slice[i];
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        off + i + 1,
        r.systemId || null,
        r.customSku || null,
        r.defaultCost === "" ? null : r.defaultCost,
        r.category,
        r.subcategory1,
      );
    }
    await client.query(
      `INSERT INTO staging_catalog_csv
       (row_no, system_id, custom_sku, default_cost, category, subcategory_1)
       VALUES ${values.join(",")}`,
      params,
    );
  }

  // Resolve each CSV row → custom_sku_id (system_id wins; fallback to sku).
  // Stored as a second TEMP for the update steps.
  await client.query(`
    CREATE TEMP TABLE staging_resolved AS
    SELECT
      s.row_no,
      s.system_id,
      s.custom_sku,
      s.default_cost,
      s.category,
      s.subcategory_1,
      COALESCE(by_sys.id, by_sku.id) AS custom_sku_id,
      CASE
        WHEN by_sys.id IS NOT NULL THEN 'system_id'
        WHEN by_sku.id IS NOT NULL THEN 'custom_sku'
        ELSE 'unmatched'
      END AS match_via
    FROM staging_catalog_csv s
    LEFT JOIN custom_skus by_sys
      ON s.system_id IS NOT NULL
     AND s.system_id <> ''
     AND by_sys.ls_system_id::text = s.system_id
    LEFT JOIN custom_skus by_sku
      ON by_sys.id IS NULL
     AND s.custom_sku IS NOT NULL
     AND s.custom_sku <> ''
     AND by_sku.sku = s.custom_sku
  `);

  const stats = await client.query(`
    SELECT
      COUNT(*)                                              AS total,
      COUNT(*) FILTER (WHERE match_via = 'system_id')       AS by_system,
      COUNT(*) FILTER (WHERE match_via = 'custom_sku')      AS by_sku,
      COUNT(*) FILTER (WHERE match_via = 'unmatched')       AS unmatched
    FROM staging_resolved
  `);
  const s = stats.rows[0];
  console.log("");
  console.log("Match summary:");
  console.log(`  matched via system_id : ${s.by_system}`);
  console.log(`  matched via sku       : ${s.by_sku}`);
  console.log(`  unmatched             : ${s.unmatched}`);
  console.log(`  total                 : ${s.total}`);

  // Show a sample of unmatched rows so the operator can spot data issues.
  const unmatchedSample = await client.query(`
    SELECT row_no, system_id, custom_sku
    FROM staging_resolved
    WHERE match_via = 'unmatched'
    ORDER BY row_no
    LIMIT 10
  `);
  if (unmatchedSample.rows.length > 0) {
    console.log("First 10 unmatched rows (line in CSV, system_id, custom_sku):");
    for (const r of unmatchedSample.rows) {
      console.log(`  line ${r.row_no + 1}: ${r.system_id || "—"}  /  ${r.custom_sku || "—"}`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN — rolling back without writes.");
    await client.query("ROLLBACK");
  } else {
  // Update default_cost on matched custom_skus.
  // Skip rows where the CSV's cost is null OR equals the existing value.
  const costR = await client.query(`
    UPDATE custom_skus cs
    SET default_cost = sr.default_cost
    FROM staging_resolved sr
    WHERE sr.custom_sku_id = cs.id
      AND sr.default_cost IS NOT NULL
      AND cs.default_cost IS DISTINCT FROM sr.default_cost
  `);

  // Update category/subcategory_1 on the matrix that owns each matched
  // custom_sku. Multiple variants under one matrix collapse to a single
  // matrix row via DISTINCT; last-write-wins on conflict (rare — the CSV
  // is matrix-consistent in practice).
  const catR = await client.query(`
    WITH per_matrix AS (
      SELECT DISTINCT ON (cs.matrix_id)
        cs.matrix_id,
        sr.category,
        sr.subcategory_1
      FROM staging_resolved sr
      INNER JOIN custom_skus cs ON cs.id = sr.custom_sku_id
      WHERE sr.category IS NOT NULL OR sr.subcategory_1 IS NOT NULL
      ORDER BY cs.matrix_id, sr.row_no
    )
    UPDATE matrices m
    SET
      category      = COALESCE(pm.category, m.category),
      subcategory_1 = COALESCE(pm.subcategory_1, m.subcategory_1)
    FROM per_matrix pm
    WHERE pm.matrix_id = m.id
      AND (m.category      IS DISTINCT FROM COALESCE(pm.category,      m.category)
        OR m.subcategory_1 IS DISTINCT FROM COALESCE(pm.subcategory_1, m.subcategory_1))
  `);

  console.log("");
  console.log("Writes:");
  console.log(`  custom_skus.default_cost updated : ${costR.rowCount}`);
  console.log(`  matrices.category/subcat updated : ${catR.rowCount}`);

  await client.query("COMMIT");
  console.log("Committed.");
  } // end else (non-dry-run)
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
