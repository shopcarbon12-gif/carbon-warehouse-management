/**
 * Creates the database named in DATABASE_URL if it does not exist (connects to `postgres` first).
 */
import nextEnv from "@next/env";
import postgres from "postgres";

nextEnv.loadEnvConfig(process.cwd());
const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const adminUrl = raw.replace(/\/[^/?#]+(?=[?#]|$)/, "/postgres");
const dbMatch = raw.match(/\/([^/?#]+)(?:[?#]|$)/);
const dbName = dbMatch?.[1];
if (!dbName || dbName === "postgres") {
  console.error("Could not parse target database name from DATABASE_URL");
  process.exit(1);
}
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
  console.error("Database name must be a simple PostgreSQL identifier");
  process.exit(1);
}

const sql = postgres(adminUrl, { max: 1, prepare: false });
const [exists] = await sql`
  SELECT 1 AS ok FROM pg_database WHERE datname = ${dbName}
`;
if (!exists) {
  await sql.unsafe(`CREATE DATABASE ${dbName}`);
  console.log("Created database:", dbName);
} else {
  console.log("Database already exists:", dbName);
}
await sql.end();
