/**
 * When Coolify Postgres public port times out from your PC (firewall), forward it over SSH:
 *   localPort → server's 127.0.0.1:remotePort → Postgres
 *
 * Prereqs: `ssh` in PATH, key or agent access to the VPS (no password prompt if BatchMode).
 *
 * Usage (from repo root):
 *   node scripts/copy-bins-through-tunnel.mjs
 *   node scripts/copy-bins-through-tunnel.mjs -- --dry-run
 *
 * Env (optional):
 *   COOLIFY_SSH_HOST   (default: host from COOLIFY_DEPLOY_WEBHOOK_URL)
 *   COOLIFY_SSH_USER   (default: root)
 *   COOLIFY_SSH_REMOTE_PG_PORT — host-published Postgres port on VPS (default: 3000)
 *   COOLIFY_SSH_LOCAL_PORT  (default: 15432)
 *
 * Target DATABASE_URL is taken from .env.coolify.local, rewritten to 127.0.0.1:LOCAL_PORT.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dotenvPath = path.join(root, ".env.coolify.local");

function loadCoolifyLocal() {
  if (!fs.existsSync(dotenvPath)) {
    console.error("Missing .env.coolify.local");
    process.exit(1);
  }
  let text = fs.readFileSync(dotenvPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function defaultSshHostFromWebhook(webhook) {
  if (!webhook) return "";
  try {
    return new URL(webhook).hostname;
  } catch {
    return "";
  }
}

function waitForLocalPort(port, ms = 20000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    function tryOnce() {
      const s = net.connect(port, "127.0.0.1", () => {
        s.destroy();
        resolve();
      });
      s.on("error", () => {
        s.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timeout: nothing listening on 127.0.0.1:${port} (SSH forward failed?)`));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
    }
    tryOnce();
  });
}

function rewriteTargetUrl(original, localPort) {
  const u = new URL(original.replace(/^postgresql:/i, "http:"));
  const user = u.username ? decodeURIComponent(u.username) : "postgres";
  const pass = u.password ? decodeURIComponent(u.password) : "";
  const db = (u.pathname || "/postgres").replace(/^\//, "") || "postgres";
  const auth =
    pass !== "" ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}` : encodeURIComponent(user);
  return `postgresql://${auth}@127.0.0.1:${localPort}/${db}`;
}

const coolify = loadCoolifyLocal();
const targetTemplate = coolify.DATABASE_URL?.trim();
if (!targetTemplate || !targetTemplate.startsWith("postgresql")) {
  console.error("DATABASE_URL missing in .env.coolify.local. Run: npm run coolify:fetch-database-url-local");
  process.exit(1);
}

const sshHost =
  process.env.COOLIFY_SSH_HOST?.trim() || defaultSshHostFromWebhook(coolify.COOLIFY_DEPLOY_WEBHOOK_URL);
const sshUser = process.env.COOLIFY_SSH_USER?.trim() || "root";
const remotePort = Number(process.env.COOLIFY_SSH_REMOTE_PG_PORT?.trim() || coolify.COOLIFY_POSTGRES_PUBLIC_PORT || "3000");
const localPort = Number(process.env.COOLIFY_SSH_LOCAL_PORT?.trim() || "15432");

if (!sshHost) {
  console.error("Set COOLIFY_SSH_HOST or COOLIFY_DEPLOY_WEBHOOK_URL in .env.coolify.local");
  process.exit(1);
}

const extraArgs = process.argv.slice(2).filter((a) => a === "--dry-run" || a === "--force-same");
const dryRun = extraArgs.includes("--dry-run");

const forwardSpec = `${localPort}:127.0.0.1:${remotePort}`;
const sshArgs = [
  "-N",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-L",
  forwardSpec,
  `${sshUser}@${sshHost}`,
];

console.log(`SSH tunnel: 127.0.0.1:${localPort} → ${sshHost}:127.0.0.1:${remotePort}`);
console.log(`User: ${sshUser}@${sshHost}`);
if (dryRun) console.log("(dry-run: will still open tunnel briefly to verify, then run copy-bins dry-run)");

const ssh = spawn("ssh", sshArgs, {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let sshErr = "";
ssh.stderr?.on("data", (c) => {
  sshErr += c.toString();
});

ssh.on("error", (e) => {
  console.error("Failed to start ssh:", e.message);
  console.error("Install OpenSSH client or use Git Bash, then retry.");
  process.exit(1);
});

function shutdown(code) {
  ssh.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

await new Promise((r) => setTimeout(r, 800));
try {
  await waitForLocalPort(localPort, 25000);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error("SSH stderr:", sshErr.slice(-800) || "(empty)");
  ssh.kill("SIGTERM");
  process.exit(1);
}

const tunneledTarget = rewriteTargetUrl(targetTemplate, localPort);
const child = spawn(process.execPath, ["scripts/copy-bins-to-target.mjs", ...extraArgs], {
  cwd: root,
  env: { ...process.env, TARGET_DATABASE_URL: tunneledTarget },
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code) => {
  shutdown(code ?? 1);
});
