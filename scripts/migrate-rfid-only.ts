/**
 * Applies only `scripts/migrations/*.sql` (no `scripts/schema.sql`).
 * Use when the baseline schema is already present and you need RFID / tail migrations only.
 */
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { applyRfidMigrations, requireDatabaseUrl } from "./migrate-shared";

loadEnvConfig(process.cwd());

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  const cwd = process.cwd();
  try {
    const n = await applyRfidMigrations(pool, cwd);
    console.log(
      `db:migrate:incremental finished (${n} SQL statement(s) from migration files).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  if ((e as { code?: string })?.code === "ECONNREFUSED") {
    console.error(
      "Postgres refused the connection. Start local DB: docker compose up -d",
    );
  }
  console.error(e);
  process.exit(1);
});
