/**
 * Insert the same Orlando (001) bin grid as `scripts/seed.ts` — no second DB required.
 *
 *   npm run db:ensure-orlando-bins              # uses DATABASE_URL from .env / env
 *   npm run db:ensure-orlando-bins:coolify      # uses DATABASE_URL from .env.coolify.local
 *
 * Options:
 *   --dry-run              Print counts only
 *   --tenant-slug=slug     Default: cj (seed tenant)
 *   --location-code=code Default: 001
 */
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function parseEnvLineFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Same algorithm as scripts/seed.ts */
function generateOrlandoWarehouseBinCodes() {
  const out = [];
  const rows = [
    { row: "1", aisleCount: 11 },
    { row: "2", aisleCount: 8 },
    { row: "3", aisleCount: 8 },
    { row: "4", aisleCount: 8 },
    { row: "5", aisleCount: 8 },
    { row: "6", aisleCount: 2 },
  ];
  const sections = ["01", "02", "03", "04", "05"];
  const positions = ["L", "C", "R"];
  for (const { row, aisleCount } of rows) {
    for (let i = 0; i < aisleCount; i++) {
      const aisle = `${row}${String.fromCharCode(65 + i)}`;
      for (const sec of sections) {
        for (const pos of positions) {
          out.push(`${aisle}${sec}${pos}`);
        }
      }
    }
  }
  return out;
}

function parseArgs(argv) {
  let dryRun = false;
  let tenantSlug = process.env.TENANT_SLUG?.trim() || "cj";
  let locationCode = process.env.LOCATION_CODE?.trim() || "001";
  let coolify = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    if (a === "--coolify") coolify = true;
    const m = a.match(/^--tenant-slug=(.+)$/);
    if (m) tenantSlug = m[1].trim();
    const m2 = a.match(/^--location-code=(.+)$/);
    if (m2) locationCode = m2[1].trim();
  }
  return { dryRun, tenantSlug, locationCode, coolify };
}

function resolveDatabaseUrl(coolify) {
  if (process.env.ENSURE_BINS_DATABASE_URL?.trim()) {
    return process.env.ENSURE_BINS_DATABASE_URL.trim();
  }
  if (coolify) {
    const u = parseEnvLineFile(path.join(root, ".env.coolify.local")).DATABASE_URL?.trim();
    if (u) return u;
    console.error("Missing DATABASE_URL in .env.coolify.local (or set ENSURE_BINS_DATABASE_URL).");
    process.exit(1);
  }
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const dot = parseEnvLineFile(path.join(root, ".env")).DATABASE_URL?.trim();
  if (dot) return dot;
  console.error("Missing DATABASE_URL (.env) or use --coolify with .env.coolify.local.");
  process.exit(1);
}

async function main() {
  const { dryRun, tenantSlug, locationCode, coolify } = parseArgs(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl(coolify);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const loc = await pool.query(
      `SELECT l.id::text AS id, l.code, l.name, t.slug AS tenant_slug
       FROM locations l
       INNER JOIN tenants t ON t.id = l.tenant_id
       WHERE t.slug = $1 AND l.code = $2
       LIMIT 1`,
      [tenantSlug, locationCode],
    );
    if (!loc.rows[0]) {
      const tenants = await pool.query(`SELECT slug, name FROM tenants ORDER BY slug`);
      const locs = await pool.query(
        `SELECT t.slug, l.code, l.name
         FROM locations l
         INNER JOIN tenants t ON t.id = l.tenant_id
         ORDER BY t.slug, l.code`,
      );
      console.error(
        `No location found for tenant_slug=${tenantSlug} location_code=${locationCode}.`,
      );
      console.error("Tenants:", tenants.rows);
      console.error("Locations:", locs.rows);
      console.error("Retry with e.g. --tenant-slug=YOUR_SLUG --location-code=001");
      process.exit(1);
    }

    const locationId = loc.rows[0].id;
    const codes = generateOrlandoWarehouseBinCodes();

    const before = await pool.query(
      `SELECT COUNT(*)::text AS n FROM bins WHERE location_id = $1::uuid AND archived_at IS NULL`,
      [locationId],
    );
    const nBefore = Number(before.rows[0]?.n ?? 0);

    console.log(
      `Target: tenant=${loc.rows[0].tenant_slug} location=${loc.rows[0].code} (${loc.rows[0].name}) id=${locationId}`,
    );
    console.log(`Orlando grid codes to ensure: ${codes.length}; existing active bins: ${nBefore}`);

    if (dryRun) {
      console.log("(dry-run — no INSERT)");
      return;
    }

    await pool.query(
      `INSERT INTO bins (location_id, code)
       SELECT $1::uuid, unnest($2::text[])
       ON CONFLICT (location_id, code) DO NOTHING`,
      [locationId, codes],
    );

    const after = await pool.query(
      `SELECT COUNT(*)::text AS n FROM bins WHERE location_id = $1::uuid AND archived_at IS NULL`,
      [locationId],
    );
    const nAfter = Number(after.rows[0]?.n ?? 0);
    console.log(
      `Done: added ${nAfter - nBefore} new bin row(s); active bins now ${nAfter} (was ${nBefore}).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
