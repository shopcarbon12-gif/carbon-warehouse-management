/**
 * READ-ONLY: inspect the most recent cycle_count_sessions so we can decide how
 * to merge the Cloud+Geiger found EPCs into the last session.
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
    const key = t.slice(0, i).trim();
    if (key !== "DATABASE_URL" || process.env.DATABASE_URL) continue;
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env.DATABASE_URL = val;
  }
}
if (!process.env.DATABASE_URL) loadEnvFile(".env.coolify.local");
if (!process.env.DATABASE_URL) loadEnvFile(".env.local");
if (!process.env.DATABASE_URL) loadEnvFile(".env");

const url = process.env.DATABASE_URL?.trim();
if (!url) { console.error("No DATABASE_URL"); process.exit(1); }

const pool = new pg.Pool({ connectionString: url, max: 1, ssl: false });
try {
  const host = (() => { try { return new URL(url.replace(/^postgresql:/, "http:")).hostname; } catch { return "?"; } })();
  console.log("DB host:", host);

  const r = await pool.query(`
    SELECT id, name, status, location_id, bin_id, session_number,
           started_at, completed_at,
           jsonb_array_length(expected_snapshot) AS expected_n,
           jsonb_array_length(scanned_epcs)       AS scanned_n,
           variance_summary,
           add_on_completed_at
      FROM cycle_count_sessions
     ORDER BY started_at DESC
     LIMIT 8`);
  console.log("\n=== Most recent cycle_count_sessions ===");
  for (const row of r.rows) {
    console.log(JSON.stringify(row));
  }
} catch (e) {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await pool.end();
}
