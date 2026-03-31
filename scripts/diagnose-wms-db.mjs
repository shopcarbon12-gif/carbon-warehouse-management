/**
 * Lists missing WMS core tables for a DATABASE_URL (local or production).
 *
 *   node scripts/diagnose-wms-db.mjs
 * Loads DATABASE_URL from .env then .env.coolify.local (first wins if set in env).
 *
 *   DATABASE_URL="postgresql://..." node scripts/diagnose-wms-db.mjs
 */
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

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

if (!process.env.DATABASE_URL) loadEnvFile(".env");
if (!process.env.DATABASE_URL) loadEnvFile(".env.coolify.local");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("Set DATABASE_URL or add it to .env / .env.coolify.local");
  process.exit(1);
}

const core = ["locations", "bins", "tenants", "users", "items", "audit_log"];
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await pool.query("SELECT 1");
  const r = await pool.query(
    `SELECT table_name AS t
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [core],
  );
  const have = new Set(r.rows.map((x) => String(x.t)));
  const missing = core.filter((c) => !have.has(c));
  console.log("DATABASE_URL host:", (() => {
    try {
      return new URL(url.replace(/^postgresql:/, "http:")).hostname;
    } catch {
      return "(parse failed)";
    }
  })());
  if (missing.length === 0) {
    console.log("OK: all core tables present:", core.join(", "));
    process.exit(0);
  }
  console.error("MISSING tables:", missing.join(", "));
  console.error("Expected on this DB after WMS_AUTO_MIGRATE=1 container boot or npm run db:migrate.");
  process.exit(1);
} catch (e) {
  console.error("Connection/query failed:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await pool.end();
}
