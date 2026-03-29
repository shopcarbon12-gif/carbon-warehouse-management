import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

/** Call `loadEnvConfig(process.cwd())` in the entry script before this. */
export function requireDatabaseUrl(): string {
  const u = process.env.DATABASE_URL?.trim();
  if (!u) {
    console.error("DATABASE_URL is required (copy .env.example to .env).");
    throw new Error("DATABASE_URL is required");
  }
  return u;
}

export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function applySqlFile(
  pool: Pool,
  label: string,
  absolutePath: string,
): Promise<number> {
  const statements = splitStatements(readFileSync(absolutePath, "utf8"));
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log(`Applied ${statements.length} statement(s) from ${label}`);
  return statements.length;
}

export async function regclass(pool: Pool, name: string): Promise<string | null> {
  const r = await pool.query<{ t: string | null }>(
    `SELECT to_regclass($1)::text AS t`,
    [name],
  );
  const v = r.rows[0]?.t;
  return v && v !== "-" ? v : null;
}

function isLegacyRfidMigration(name: string): boolean {
  return (
    name.startsWith("001_") ||
    name.startsWith("002_") ||
    name.startsWith("003_")
  );
}

/**
 * Applies `scripts/migrations/*.sql`:
 * - **Legacy (001–003):** only when `public.matrices` is missing (gated; may skip 001 if `products` exists).
 * - **Tail (004+):** always applied so schema fixes (e.g. status CHECK) run on existing DBs.
 */
export async function applyRfidMigrations(
  pool: Pool,
  cwd: string,
): Promise<number> {
  const migrationsDir = join(cwd, "scripts/migrations");
  if (!existsSync(migrationsDir)) {
    console.log("No scripts/migrations directory; skipping RFID migrations.");
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
        "Found public.products without matrices — applying 002 + 003 only (skipping 001).",
      );
      files = files.filter((n) => !n.startsWith("001_"));
    } else {
      console.log("Applying RFID legacy migrations: 001 → 002 → 003.");
    }
    for (const name of files) {
      total += await applySqlFile(
        pool,
        `scripts/migrations/${name}`,
        join(migrationsDir, name),
      );
    }
  } else {
    console.log(
      "RFID legacy (001–003): public.matrices exists — skipping.",
    );
  }

  for (const name of tailFiles) {
    total += await applySqlFile(
      pool,
      `scripts/migrations/${name}`,
      join(migrationsDir, name),
    );
  }

  return total;
}

/** Baseline `schema.sql` + `applyRfidMigrations` in one pool lifecycle. */
export async function runFullMigration(cwd: string): Promise<number> {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  try {
    let total = await applySqlFile(
      pool,
      "scripts/schema.sql",
      join(cwd, "scripts/schema.sql"),
    );
    total += await applyRfidMigrations(pool, cwd);
    return total;
  } finally {
    await pool.end();
  }
}
