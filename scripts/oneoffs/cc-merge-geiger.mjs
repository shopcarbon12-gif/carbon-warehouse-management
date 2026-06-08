/**
 * Merge Cloud+Geiger `found` EPCs into the last committed cycle count session
 * (026 / 4e01fcf6...). Updates scanned_epcs, variance_summary, and
 * scanned_epc_sources (first-sighting-wins). Items table is NOT touched.
 *
 * Reversible via scripts/oneoffs/cc-026-backup-pre-geiger-merge.json.
 */
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");
function load(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return;
  let t = fs.readFileSync(p, "utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const ln of t.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    if (s.slice(0, i).trim() !== "DATABASE_URL" || process.env.DATABASE_URL) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env.DATABASE_URL = v;
  }
}
if (!process.env.DATABASE_URL) load(".env.coolify.local");

const SID = "4e01fcf6-592d-417d-88a4-ca162e30b8f8";
const SOURCE_NAME = "Cloud+Geiger find";
const SOURCE_TS = "2026-06-07T21:15:45.555693Z";

const csv = fs.readFileSync(path.join(__dirname, "cg-find-upload40.csv"), "utf8")
  .split(/\r?\n/).slice(1).filter(Boolean);
const found = [...new Set(
  csv.filter((l) => l.split(",")[1] === "found").map((l) => l.split(",")[0].trim().toUpperCase())
)];
console.log("found EPCs to merge:", found.length);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: false });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const r = await client.query(
    "SELECT tenant_id, expected_snapshot, scanned_epcs, scanned_epc_sources, variance_summary FROM cycle_count_sessions WHERE id=$1::uuid FOR UPDATE",
    [SID]);
  const row = r.rows[0];
  if (!row) throw new Error("session not found");

  const expected = new Set((row.expected_snapshot || []).map((e) => String(e.epc ?? e).toUpperCase()));
  const scanned = new Set((row.scanned_epcs || []).map((e) => String(e).toUpperCase()));
  const before = scanned.size;
  let added = 0;
  for (const e of found) { if (!scanned.has(e)) { scanned.add(e); added++; } }

  // recompute variance the same way closeCycleCountFromAddOn does
  let matched = 0;
  for (const e of expected) if (scanned.has(e)) matched++;
  const missing = expected.size - matched;
  const variance = { matched, missing, misplaced: 0, unrecognized: 0 };

  // sources: first-sighting-wins — only add EPCs not already attributed
  const sources = { ...(row.scanned_epc_sources || {}) };
  let srcAdded = 0;
  for (const e of found) {
    if (!sources[e]) { sources[e] = { kind: "mobile", name: SOURCE_NAME, ts: SOURCE_TS }; srcAdded++; }
  }

  const mergedScanned = [...scanned];
  console.log(`scanned ${before} -> ${mergedScanned.length} (added ${added})`);
  console.log("new variance:", JSON.stringify(variance));
  console.log("sources added:", srcAdded);

  const upd = await client.query(
    `UPDATE cycle_count_sessions
        SET scanned_epcs        = $2::jsonb,
            variance_summary    = $3::jsonb,
            scanned_epc_sources = $4::jsonb,
            updated_at          = now()
      WHERE id = $1::uuid
      RETURNING jsonb_array_length(scanned_epcs) AS n, variance_summary`,
    [SID, JSON.stringify(mergedScanned), JSON.stringify(variance), JSON.stringify(sources)]);
  console.log("UPDATED:", JSON.stringify(upd.rows[0]));

  await client.query("COMMIT");
  console.log("COMMITTED");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("ROLLED BACK:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
