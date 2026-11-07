#!/usr/bin/env node
/**
 * READ-ONLY query against the production database (owner-approved 2026-11-07).
 *
 *   node scripts/prod-db-read.cjs "SELECT ... "
 *
 * Prints the rows as JSON. It cannot change anything:
 *   - the query runs inside BEGIN TRANSACTION READ ONLY, so Postgres itself
 *     rejects INSERT/UPDATE/DELETE/DDL ("cannot execute ... in a read-only transaction");
 *   - it is sent as a single extended-protocol statement (with a parameter
 *     list), so "...; COMMIT; DELETE ..." is refused by Postgres;
 *   - it always ends with ROLLBACK, with a 30 s statement timeout.
 *
 * Prod Postgres is only reachable through an SSH tunnel (edge firewall, see
 * AGENT_CREDENTIALS.md): if localhost:16544 is not listening, this opens
 * `ssh -fNT -L 16544:127.0.0.1:2040 root@152.53.210.171` first.
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require(path.join(__dirname, "..", "node_modules", "pg"));

const PORT = 16544;
const HOST = "152.53.210.171";

function listening() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function main() {
  const sql = process.argv[2];
  if (!sql || !sql.trim()) {
    console.error('usage: node scripts/prod-db-read.cjs "SELECT ..."');
    process.exit(2);
  }
  if (!(await listening())) {
    execFileSync("ssh", ["-i", `${process.env.HOME}/.ssh/id_ed25519`, "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-fNT", "-L", `${PORT}:127.0.0.1:2040`, `root@${HOST}`], { stdio: "inherit" });
  }
  const env = fs.readFileSync(path.join(__dirname, "..", ".env.coolify.local"), "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("DATABASE_URL missing in .env.coolify.local");
  const url = m[1].trim().replace(/^['"]|['"]$/g, "").replace(`${HOST}:2040`, `localhost:${PORT}`);
  const c = new Client({ connectionString: url, ssl: false });
  await c.connect();
  try {
    await c.query("BEGIN TRANSACTION READ ONLY");
    await c.query("SET LOCAL statement_timeout = '30s'");
    // A parameter list forces the extended protocol: exactly one statement.
    const r = await c.query({ text: sql, values: [] });
    console.log(JSON.stringify(r.rows));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
