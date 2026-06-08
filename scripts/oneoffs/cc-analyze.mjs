/**
 * READ-ONLY analysis: how the Cloud+Geiger `found` EPCs intersect with the
 * last committed cycle count session (026 / 4e01fcf6...).
 */
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");
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
    if (t.slice(0, i).trim() !== "DATABASE_URL" || process.env.DATABASE_URL) continue;
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env.DATABASE_URL = val;
  }
}
if (!process.env.DATABASE_URL) loadEnvFile(".env.coolify.local");
if (!process.env.DATABASE_URL) loadEnvFile(".env.local");
if (!process.env.DATABASE_URL) loadEnvFile(".env");

const SESSION_ID = "4e01fcf6-592d-417d-88a4-ca162e30b8f8";

// Parse CSV -> found EPCs (uppercased, deduped)
const csv = fs.readFileSync(path.join(__dirname, "cg-find-upload40.csv"), "utf8");
const lines = csv.split(/\r?\n/).slice(1).filter(Boolean);
const foundSet = new Set();
const notFoundSet = new Set();
for (const ln of lines) {
  const [epc, found] = ln.split(",");
  if (!epc) continue;
  const e = epc.trim().toUpperCase();
  if (found === "found") foundSet.add(e);
  else notFoundSet.add(e);
}
console.log("CSV rows:", lines.length, "| unique found:", foundSet.size, "| unique not_found:", notFoundSet.size);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: false });
try {
  const s = await pool.query(
    `SELECT tenant_id, location_id, expected_snapshot, scanned_epcs, variance_summary
       FROM cycle_count_sessions WHERE id = $1::uuid`, [SESSION_ID]);
  const row = s.rows[0];
  const expected = new Set(
    (row.expected_snapshot || []).map((e) => String(e.epc ?? e).toUpperCase())
  );
  const scanned = new Set((row.scanned_epcs || []).map((e) => String(e).toUpperCase()));
  console.log("\nSession 026: expected", expected.size, "| scanned", scanned.size, "| variance", JSON.stringify(row.variance_summary));

  let foundInExpected = 0, foundAlreadyScanned = 0, foundExpectedNotScanned = 0, foundNotInExpected = 0;
  const reducesMissing = []; // expected & not currently scanned
  for (const e of foundSet) {
    const inExp = expected.has(e);
    const inScan = scanned.has(e);
    if (inExp) foundInExpected++;
    if (inExp && inScan) foundAlreadyScanned++;
    if (inExp && !inScan) { foundExpectedNotScanned++; reducesMissing.push(e); }
    if (!inExp) foundNotInExpected++;
  }
  console.log("\n--- FOUND EPCs vs session 026 ---");
  console.log("found total (unique):       ", foundSet.size);
  console.log("  in expected snapshot:     ", foundInExpected);
  console.log("    already in scanned:     ", foundAlreadyScanned, "(no effect)");
  console.log("    expected & NOT scanned: ", foundExpectedNotScanned, "(THESE reduce missing)");
  console.log("  NOT in expected snapshot: ", foundNotInExpected, "(extra / would be unrecognized)");

  const projectedMissing = (row.variance_summary?.missing ?? 0) - reducesMissing.length;
  const projectedMatched = (row.variance_summary?.matched ?? 0) + reducesMissing.length;
  console.log("\nProjected after merge: matched", projectedMatched, "| missing", projectedMissing);

  // Current items.status for the found EPCs (are they 'unknown' from the kill step?)
  const foundArr = [...foundSet];
  const st = await pool.query(
    `SELECT status, COUNT(*)::int AS n
       FROM items
      WHERE tenant_id = $1::uuid AND UPPER(epc) = ANY($2::text[])
      GROUP BY status ORDER BY n DESC`,
    [row.tenant_id, foundArr]);
  console.log("\n--- items.status for the", foundArr.length, "found EPCs (tenant-scoped) ---");
  for (const r of st.rows) console.log(" ", r.status, "=>", r.n);
  const totalMatchedItems = st.rows.reduce((a, r) => a + r.n, 0);
  console.log("  (rows found in items table:", totalMatchedItems, ")");

  // Of the reduces-missing set specifically, what status?
  const st2 = await pool.query(
    `SELECT status, COUNT(*)::int AS n
       FROM items
      WHERE tenant_id = $1::uuid AND UPPER(epc) = ANY($2::text[])
      GROUP BY status ORDER BY n DESC`,
    [row.tenant_id, reducesMissing]);
  console.log("\n--- items.status for the", reducesMissing.length, "reduces-missing EPCs ---");
  for (const r of st2.rows) console.log(" ", r.status, "=>", r.n);
} catch (e) {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await pool.end();
}
