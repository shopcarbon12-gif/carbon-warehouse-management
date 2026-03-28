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
  console.error(e);
  process.exit(1);
});
