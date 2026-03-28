import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres from "postgres";

loadEnvConfig(process.cwd());

function requireDatabaseUrl(): string {
  const u = process.env.DATABASE_URL?.trim();
  if (!u) {
    console.error("DATABASE_URL is required (copy .env.example to .env).");
    throw new Error("DATABASE_URL is required");
  }
  return u;
}

async function main() {
  const sql = postgres(requireDatabaseUrl(), { max: 1, prepare: false });
  const [already] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'
    LIMIT 1
  `;
  if (already) {
    await sql.end();
    console.log("Schema already applied (table public.users exists). Skipping migrate.");
    return;
  }

  const file = readFileSync(join(process.cwd(), "scripts/schema.sql"), "utf8");
  const statements = file
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }

  await sql.end();
  console.log(`Applied ${statements.length} SQL statements from scripts/schema.sql`);
}

main().catch((e) => {
  const refused =
    (e as { code?: string })?.code === "ECONNREFUSED" ||
    (e as { errors?: { code?: string }[] })?.errors?.some(
      (x) => x?.code === "ECONNREFUSED",
    );
  if (refused) {
    console.error(
      "Postgres refused the connection (nothing listening on DATABASE_URL).\n" +
        "  Start local DB: docker compose up -d\n" +
        "  Then: npm run db:migrate",
    );
  }
  console.error(e);
  process.exit(1);
});
