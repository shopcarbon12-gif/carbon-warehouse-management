/**
 * Container bootstrap migrations: same logic as `npm run db:migrate` / `migrate-shared.ts`.
 * Uses `pg` (same TLS/URL handling as Next) — avoids Alpine `psql` quirks and **does not**
 * re-run legacy 001–003 when `public.matrices` exists (unlike the old psql loop, which could
 * execute 002's DROP TABLE on every boot).
 *
 * Run from docker-entrypoint when WMS_AUTO_MIGRATE=1. CWD must be /app (Dockerfile WORKDIR).
 *
 * Load `pg` via createRequire(package.json): ESM `import pg` can fail or miss hoisted deps in
 * `.next/standalone` traces. Dockerfile also merges `pg` + subtree from the full `npm ci` layer.
 *
 * Tracking (added 2026-05-02): every applied migration is recorded in `schema_migrations`.
 * Future deploys skip files already present in the table — this prevents re-running
 * non-idempotent UPDATE/INSERT statements on every boot. On first run against an existing
 * database (matrices already present, table just created), every current file is backfilled
 * as "applied" so we don't re-execute prior migrations against an already-evolved schema.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

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

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
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

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadAppliedSet(pool) {
  const r = await pool.query(`SELECT name FROM public.schema_migrations`);
  return new Set(r.rows.map((row) => row.name));
}

async function recordApplied(pool, name, checksum) {
  await pool.query(
    `INSERT INTO public.schema_migrations (name, checksum)
       VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
    [name, checksum],
  );
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

  await ensureMigrationsTable(pool);
  let applied = await loadAppliedSet(pool);

  // Bootstrap: schema is already evolved (matrices exists) but tracking table is empty.
  // Backfill every current file as already-applied so we don't re-execute migrations
  // against an already-built schema. This is the safe path on the first deploy after
  // tracking goes live; the alternative (replay everything) would break.
  const hasMatrices = await regclass(pool, "public.matrices");
  if (hasMatrices && applied.size === 0) {
    console.log(
      `wms: schema_migrations bootstrap — matrices already exists; marking ${allNames.length} file(s) as applied without re-running.`,
    );
    for (const name of allNames) {
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      await recordApplied(pool, name, sha256Hex(sql));
    }
    applied = await loadAppliedSet(pool);
    return 0;
  }

  let total = 0;

  // Fresh database: run legacy 001–003 first so the rest of the chain has a baseline.
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
      if (applied.has(name)) {
        console.log(`wms: skip already-applied ${name}`);
        continue;
      }
      const path = join(migrationsDir, name);
      const sql = readFileSync(path, "utf8");
      total += await applySqlFile(pool, `scripts/migrations/${name}`, path);
      await recordApplied(pool, name, sha256Hex(sql));
    }
  }

  // Apply every non-legacy file not yet recorded as applied.
  let skipped = 0;
  for (const name of tailFiles) {
    if (applied.has(name)) {
      skipped += 1;
      continue;
    }
    const path = join(migrationsDir, name);
    const sql = readFileSync(path, "utf8");
    total += await applySqlFile(pool, `scripts/migrations/${name}`, path);
    await recordApplied(pool, name, sha256Hex(sql));
  }
  if (skipped > 0) {
    console.log(`wms: skipped ${skipped} already-applied tail migration(s).`);
  }

  return total;
}

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  try {
    console.log("wms: docker-migrate.mjs — baseline schema.sql + tracked migrations (pg)");
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
