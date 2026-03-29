/**
 * Alias for `scripts/migrate-incremental.ts` — same full pipeline (schema + migrations).
 */
import { loadEnvConfig } from "@next/env";
import { runFullMigration } from "./migrate-shared";

loadEnvConfig(process.cwd());

async function main() {
  const total = await runFullMigration(process.cwd());
  console.log(`db:migrate finished (${total} SQL statement(s) total).`);
}

main().catch((e) => {
  if ((e as { code?: string })?.code === "ECONNREFUSED") {
    console.error(
      "Postgres refused the connection (nothing listening on DATABASE_URL).\n" +
        "  Start local DB: docker compose up -d\n" +
        "  Then: npm run db:migrate",
    );
  }
  console.error(e);
  process.exit(1);
});
