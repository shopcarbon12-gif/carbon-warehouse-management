/**
 * Reach Coolify's API/webhooks from a dev box or agent session.
 *
 * Since the 2026-10-25 edge firewall only 80/443 are public on the prod host,
 * so `http://152.53.210.171:8000/...` (the origin in every webhook URL) times
 * out from anywhere off the box. `coolifyOrigin(url)` probes the origin; when it
 * does not answer, it opens an SSH local forward to 127.0.0.1:8000 on the host
 * (key ~/.ssh/id_ed25519, user root — the same path as the prod DB tunnel) and
 * returns `rewrite(url)` that points any Coolify URL at the tunnel. The tunnel
 * is closed when the process exits.
 *
 * Env overrides: COOLIFY_SSH_HOST (default: the webhook's host), COOLIFY_SSH_USER
 * (root), COOLIFY_SSH_KEY (~/.ssh/id_ed25519), COOLIFY_NO_TUNNEL=1 (never tunnel).
 */
import { spawn } from "child_process";
import net from "net";
import os from "os";
import path from "path";

async function reachable(origin, ms = 5000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    await fetch(`${origin}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForPort(port, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const ok = await new Promise((r) => {
      const c = net.connect(port, "127.0.0.1", () => (c.end(), r(true)));
      c.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** @returns {Promise<{ rewrite: (u: string) => string, tunnelled: boolean }>} */
export async function coolifyOrigin(anyCoolifyUrl) {
  const identity = { rewrite: (u) => u, tunnelled: false };
  let u;
  try {
    u = new URL(anyCoolifyUrl);
  } catch {
    return identity;
  }
  if (process.env.COOLIFY_NO_TUNNEL === "1") return identity;
  if (await reachable(u.origin)) return identity;

  const host = process.env.COOLIFY_SSH_HOST || u.hostname;
  const user = process.env.COOLIFY_SSH_USER || "root";
  const key = process.env.COOLIFY_SSH_KEY || path.join(os.homedir(), ".ssh", "id_ed25519");
  const remotePort = u.port || (u.protocol === "https:" ? "443" : "80");
  const port = await freePort();
  console.log(`Coolify ${u.origin} not reachable directly (edge firewall) — tunnelling via ssh ${user}@${host}`);
  const ssh = spawn(
    "ssh",
    ["-i", key, "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15",
     "-o", "ServerAliveInterval=30", "-N", "-L", `${port}:127.0.0.1:${remotePort}`, `${user}@${host}`],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const close = () => {
    try { ssh.kill(); } catch { /* already gone */ }
  };
  process.on("exit", close);
  if (!(await waitForPort(port))) {
    close();
    throw new Error(`could not open SSH tunnel to ${user}@${host} (key ${key})`);
  }
  const local = `http://127.0.0.1:${port}`;
  return {
    tunnelled: true,
    rewrite: (x) => {
      try {
        const v = new URL(x);
        return v.origin === u.origin ? local + v.pathname + v.search : x;
      } catch {
        return x;
      }
    },
  };
}
