/**
 * Copy all bins from a source Postgres (e.g. local) to a target (e.g. Coolify / wms.shopcarbon).
 *
 * Maps `location_id` by **tenant slug + location code** — UUIDs differ between databases.
 *
 * Usage:
 *   SOURCE_DATABASE_URL="postgresql://..." TARGET_DATABASE_URL="postgresql://..." node scripts/copy-bins-to-target.mjs
 *
 * If env vars are omitted, loads from files only (avoids shell `DATABASE_URL` matching both):
 *   - Source: SOURCE_DATABASE_URL (env), else COPY_BINS_SOURCE_DATABASE_URL or DATABASE_URL in `.env`
 *   - Target: TARGET_DATABASE_URL (env), else DATABASE_URL in `.env.coolify.local`
 *
 * Options:
 *   --dry-run     List counts only, no writes
 *   --force-same  Allow identical source/target URL (default: refuse)
 */
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const forceSame = argv.includes("--force-same");
  return { dryRun, forceSame };
}

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

function normalizeUrl(u) {
  try {
    const x = new URL(u.replace(/^postgresql:/i, "http:"));
    return `${x.hostname}:${x.port || "5432"}${x.pathname}`;
  } catch {
    return u;
  }
}

function resolveUrls() {
  const dotEnv = parseEnvLineFile(path.join(root, ".env"));
  const coolify = parseEnvLineFile(path.join(root, ".env.coolify.local"));

  const source =
    process.env.SOURCE_DATABASE_URL?.trim() ||
    dotEnv.COPY_BINS_SOURCE_DATABASE_URL?.trim() ||
    dotEnv.DATABASE_URL?.trim();
  const target =
    process.env.TARGET_DATABASE_URL?.trim() || coolify.DATABASE_URL?.trim();

  return { source, target };
}

async function main() {
  const { dryRun, forceSame } = parseArgs(process.argv.slice(2));
  const { source, target } = resolveUrls();

  if (!source) {
    console.error(
      "Missing source URL: set SOURCE_DATABASE_URL, or COPY_BINS_SOURCE_DATABASE_URL / DATABASE_URL in .env",
    );
    process.exit(1);
  }
  if (!target) {
    console.error(
      "Missing target URL: set TARGET_DATABASE_URL or DATABASE_URL in .env.coolify.local",
    );
    process.exit(1);
  }
  if (source === target && !forceSame) {
    console.error(
      "Source and target DATABASE_URL are identical — refusing. Use --force-same to override.",
    );
    process.exit(1);
  }
  if (normalizeUrl(source) === normalizeUrl(target) && !forceSame) {
    console.error(
      "Source and target resolve to the same host/database — refusing. Use --force-same to override.",
    );
    process.exit(1);
  }

  console.log("Source:", normalizeUrl(source));
  console.log("Target:", normalizeUrl(target));
  if (dryRun) console.log("(dry-run: no writes)");

  const srcPool = new pg.Pool({ connectionString: source, max: 2 });
  const dstPool = new pg.Pool({ connectionString: target, max: 2 });

  try {
    const { rows } = await srcPool.query(`
      SELECT
        b.code,
        b.capacity,
        b.status,
        b.archived_at,
        b.created_at,
        l.code AS location_code,
        t.slug AS tenant_slug
      FROM bins b
      INNER JOIN locations l ON l.id = b.location_id
      INNER JOIN tenants t ON t.id = l.tenant_id
      ORDER BY t.slug, l.code, b.code
    `);

    const locCache = new Map();

    async function resolveTargetLocationId(tenantSlug, locationCode) {
      const k = `${tenantSlug}|${locationCode}`;
      if (locCache.has(k)) return locCache.get(k);
      const r = await dstPool.query(
        `SELECT l.id::text AS id
         FROM locations l
         INNER JOIN tenants t ON t.id = l.tenant_id
         WHERE t.slug = $1 AND l.code = $2
         LIMIT 1`,
        [tenantSlug, locationCode],
      );
      const id = r.rows[0]?.id ?? null;
      locCache.set(k, id);
      return id;
    }

    let upserted = 0;
    let skippedNoLocation = 0;

    const client = await dstPool.connect();
    try {
      if (!dryRun) await client.query("BEGIN");

      for (const row of rows) {
        const locationId = await resolveTargetLocationId(
          row.tenant_slug,
          row.location_code,
        );
        if (!locationId) {
          skippedNoLocation += 1;
          console.warn(
            `Skip (no target location): tenant=${row.tenant_slug} location=${row.location_code} bin=${row.code}`,
          );
          continue;
        }

        const status = row.status ?? "active";
        const capacity = row.capacity;
        const archivedAt = row.archived_at;
        const createdAt = row.created_at;

        if (dryRun) {
          upserted += 1;
          continue;
        }

        await client.query(
          `INSERT INTO bins (location_id, code, capacity, status, archived_at, created_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6)
           ON CONFLICT (location_id, code) DO UPDATE SET
             capacity = EXCLUDED.capacity,
             status = EXCLUDED.status,
             archived_at = EXCLUDED.archived_at`,
          [
            locationId,
            row.code,
            capacity,
            status,
            archivedAt,
            createdAt,
          ],
        );
        upserted += 1;
      }

      if (!dryRun) await client.query("COMMIT");
    } catch (e) {
      if (!dryRun) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(
      `Done: ${dryRun ? "would upsert" : "upserted"} ${upserted} bin row(s); source had ${rows.length}; skipped (missing target location): ${skippedNoLocation}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = typeof e === "object" && e && "code" in e ? String((e).code) : "";
    if (
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED" ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNREFUSED")
    ) {
      console.error(`
Target Postgres is not reachable from this PC (firewall or DB port not published to the internet).

Fix: Coolify → Postgres → expose the mapped port on 0.0.0.0 and open it in the VPS firewall.

Then set TARGET_DATABASE_URL and run:
  npm run db:copy-bins
`);
    }
    throw e;
  } finally {
    await srcPool.end();
    await dstPool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
