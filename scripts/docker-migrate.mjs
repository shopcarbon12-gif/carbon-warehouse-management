/**
 * Container bootstrap migrations: same logic as `npm run db:migrate` / `migrate-shared.ts`.
 * Uses `pg` (same TLS/URL handling as Next) — avoids Alpine `psql` quirks and **does not**
 * re-run legacy 001–003 when `public.matrices` exists (unlike the old psql loop, which could
 * execute 002’s DROP TABLE on every boot).
 *
 * Run from docker-entrypoint when WMS_AUTO_MIGRATE=1. CWD must be /app (Dockerfile WORKDIR).
 *
 * Load `pg` via createRequire(package.json): ESM `import pg` can fail or miss hoisted deps in
 * `.next/standalone` traces. Dockerfile also merges `pg` + subtree from the full `npm ci` layer.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const appRoot = process.cwd();
const pkgPath = join(appRoot, "package.json");
if (!existsSync(pkgPath)) {
  console.error("wms: docker-migrate: missing package.json at", pkgPath);
  process.exit(1);
}
let Pool;
try {
  const require = createRequire(pkgPath);
  ({ Pool } = require("pg"));
} catch (e) {
  console.error(
    "wms: docker-migrate: cannot load pg — ensure node-postgres is in /app/node_modules (see Dockerfile).",
    e?.message || e,
  );
  process.exit(1);
}

function requireDatabaseUrl() {
  const u = process.env.DATABASE_URL?.trim();
  if (!u) throw new Error("DATABASE_URL is required");
  return u;
}

function splitStatements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function applySqlFile(pool, label, absolutePath) {
  const statements = splitStatements(readFileSync(absolutePath, "utf8"));
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log(`wms: Applied ${statements.length} statement(s) from ${label}`);
  return statements.length;
}

async function regclass(pool, name) {
  const r = await pool.query(`SELECT to_regclass($1)::text AS t`, [name]);
  const v = r.rows[0]?.t;
  return v && v !== "-" ? v : null;
}

function isLegacyRfidMigration(name) {
  return name.startsWith("001_") || name.startsWith("002_") || name.startsWith("003_");
}

async function applyRfidMigrations(pool, cwd) {
  const migrationsDir = join(cwd, "scripts/migrations");
  if (!existsSync(migrationsDir)) {
    console.log("wms: No scripts/migrations; skipping.");
    return 0;
  }

  const allNames = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const legacyFiles = allNames.filter(isLegacyRfidMigration);
  const tailFiles = allNames.filter((n) => !isLegacyRfidMigration(n));

  let total = 0;

  const hasMatrices = await regclass(pool, "public.matrices");
  if (!hasMatrices) {
    const hasOldProducts = await regclass(pool, "public.products");
    let files = [...legacyFiles];
    if (hasOldProducts) {
      console.log(
        "wms: public.products without matrices — applying 002 + 003 only (skip 001).",
      );
      files = files.filter((n) => !n.startsWith("001_"));
    } else {
      console.log("wms: Applying RFID legacy migrations 001 → 002 → 003.");
    }
    for (const name of files) {
      total += await applySqlFile(pool, `scripts/migrations/${name}`, join(migrationsDir, name));
    }
  } else {
    console.log("wms: public.matrices exists — skipping legacy 001–003.");
  }

  for (const name of tailFiles) {
    total += await applySqlFile(pool, `scripts/migrations/${name}`, join(migrationsDir, name));
  }

  return total;
}

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  try {
    console.log("wms: docker-migrate.mjs — baseline schema.sql + gated migrations (pg)");
    let total = await applySqlFile(pool, "scripts/schema.sql", join(appRoot, "scripts/schema.sql"));
    total += await applyRfidMigrations(pool, appRoot);
    console.log(`wms: docker-migrate OK — ${total} SQL statement(s) applied.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("wms: docker-migrate FAILED:", e?.message || e);
  process.exit(1);
});
