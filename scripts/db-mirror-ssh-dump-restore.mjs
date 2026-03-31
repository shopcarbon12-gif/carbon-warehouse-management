/**
 * Full mirror: production Postgres (Coolify Docker on VPS) → local docker-compose Postgres.
 *
 * Requires:
 *   • Non-interactive SSH as root (or COOLIFY_SSH_USER@COOLIFY_SSH_HOST) to the Coolify server
 *   • Local: `docker compose up -d` for postgres (port 5432, db carbon_wms)
 *
 * Env (optional):
 *   COOLIFY_SSH_HOST — default 178.156.136.112 (derive from COOLIFY_DEPLOY_WEBHOOK_URL if unset)
 *   COOLIFY_SSH_USER — default root
 *   COOLIFY_PG_CONTAINER — default iogw84scwo0owsco8c8wg4s0 (WMS DB container on that host)
 *   COOLIFY_PG_DUMP_DB — database name inside container (default postgres)
 *   LOCAL_PG_SERVICE — docker compose service name (default postgres)
 *   LOCAL_PG_DB — local database (default carbon_wms)
 *
 * Loads `.env.coolify.local` for COOLIFY_DEPLOY_WEBHOOK_URL only (no secrets logged).
 *
 *   node scripts/db-mirror-ssh-dump-restore.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dotenvPath = path.join(root, ".env.coolify.local");
if (fs.existsSync(dotenvPath)) {
  let text = fs.readFileSync(dotenvPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key]) continue;
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function defaultSshHost() {
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

const sshHost = process.env.COOLIFY_SSH_HOST || defaultSshHost();
const sshUser = process.env.COOLIFY_SSH_USER || "root";
const pgContainer = process.env.COOLIFY_PG_CONTAINER || "iogw84scwo0owsco8c8wg4s0";
const remoteDb = process.env.COOLIFY_PG_DUMP_DB || "postgres";
const localService = process.env.LOCAL_PG_SERVICE || "postgres";
const localDb = process.env.LOCAL_PG_DB || "carbon_wms";

if (!sshHost) {
  console.error("Set COOLIFY_SSH_HOST or COOLIFY_DEPLOY_WEBHOOK_URL in .env.coolify.local.");
  process.exit(1);
}

const tmpDir = path.join(root, ".tools", "tmp");
fs.mkdirSync(tmpDir, { recursive: true });
const dumpPath = path.join(tmpDir, "carbon_wms_prod.dump");

console.log("SSH dump:", `${sshUser}@${sshHost}`, "container", pgContainer, "db", remoteDb);
const remoteCmd = `docker exec ${pgContainer} pg_dump -U postgres -d ${remoteDb} -Fc`;

await new Promise((resolve, reject) => {
  const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", `${sshUser}@${sshHost}`, remoteCmd];
  const ssh = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.createWriteStream(dumpPath);
  let errBuf = "";
  ssh.stderr.on("data", (c) => {
    errBuf += c.toString();
  });
  ssh.stdout.pipe(out);
  ssh.on("error", reject);
  ssh.on("close", (code) => {
    out.close();
    if (code !== 0) {
      reject(new Error(`ssh exited ${code}: ${errBuf.slice(-800)}`));
      return;
    }
    resolve();
  });
});

const st = fs.statSync(dumpPath);
if (st.size < 1024) {
  console.error("Dump file too small; pg_dump may have failed. Check SSH and container name.");
  process.exit(1);
}
console.log("Wrote", dumpPath, `(${(st.size / 1024 / 1024).toFixed(2)} MiB)`);

function dockerComposeContainerName() {
  const proc = spawn("docker", ["compose", "ps", "-q", localService], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`docker compose ps: ${err || code}`));
      else resolve(out.trim().split(/\r?\n/)[0] || "");
    });
    proc.on("error", reject);
  });
}

const containerId = await dockerComposeContainerName();
if (!containerId) {
  console.error("Local postgres container not running. Run: docker compose up -d");
  process.exit(1);
}

const inspect = spawn("docker", ["inspect", "--format", "{{.Name}}", containerId], { stdio: ["ignore", "pipe", "pipe"] });
const localName = await new Promise((resolve, reject) => {
  let out = "";
  inspect.stdout.on("data", (c) => (out += c.toString()));
  inspect.on("close", (c) => (c === 0 ? resolve(out.trim()) : reject(new Error("docker inspect failed"))));
  inspect.on("error", reject);
});

const cleanName = localName.startsWith("/") ? localName.slice(1) : localName;
console.log("pg_restore →", cleanName, "db", localDb);

await new Promise((resolve, reject) => {
  const cp = spawn("docker", ["cp", dumpPath, `${cleanName}:/tmp/prod.dump`], { stdio: "inherit" });
  cp.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker cp exited ${code}`))));
  cp.on("error", reject);
});

const restoreArgs = [
  "exec",
  cleanName,
  "pg_restore",
  "-U",
  "postgres",
  "-d",
  localDb,
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-acl",
  "/tmp/prod.dump",
];

await new Promise((resolve, reject) => {
  const ex = spawn("docker", restoreArgs, { stdio: "inherit" });
  ex.on("close", (code) => {
    /* pg_restore often returns 1 for non-fatal warnings */
    if (code !== 0 && code !== 1) reject(new Error(`pg_restore exited ${code}`));
    else resolve();
  });
  ex.on("error", reject);
});

console.log("Done. Local DATABASE_URL: postgresql://postgres:postgres@localhost:5432/" + localDb);
