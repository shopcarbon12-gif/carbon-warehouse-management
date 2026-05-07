import { spawn } from "node:child_process";
import { log } from "./log.js";
import type { AgentEnv } from "./config.js";
import { postWiznetDiscoveries } from "./wms-client.js";

/**
 * Periodically discovers every WIZnet bridge on the local LAN via
 * `wiznet-cli -d` and reports the result to the WMS so it can:
 *   1. Auto-track IP changes for KNOWN readers (matched by MAC).
 *   2. Surface NEW readers in the hardware-config UI for adoption.
 *
 * `wiznet-cli` requires sudo to do its UDP discovery broadcast, so we
 * shell out to `sudo -n` (the agent runs as `shopcarbon`, which has
 * passwordless sudo on the CarbonCDM VM by design).
 *
 * Sample output (one device per line, repeated up to 4× per UDP probe):
 *   1. 0008DC1E1980  192.168.1.22  255.255.255.0  192.168.1.1  10002  N  115200 8N1  SERVER(2)  20  N
 *
 * We dedupe by MAC and keep the most recent IP for each.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const WIZNET_CLI = "/opt/legacy-rfid/wiznet-cli";
const SCAN_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;
/**
 * MACs we've already attempted to lock in this agent process. Prevents
 * re-issuing wiznet-cli against a bridge whose first lock attempt failed
 * for a non-recoverable reason (e.g. the bridge isn't responding to UDP
 * config commands). The set resets on agent restart, so a transient
 * failure can recover after a systemd respawn.
 */
const LOCK_ATTEMPTED = new Set<string>();

type WiznetRecord = {
  mac: string;
  ip: string;
  port: number;
  dhcp: boolean;
  raw: Record<string, string>;
};

function parseWiznetCliOutput(text: string): WiznetRecord[] {
  const out = new Map<string, WiznetRecord>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // Match a row like:
    //   "  1. 0008DC1E1980  192.168.1.22  255.255.255.0  192.168.1.1  10002  N  ..."
    const m = line.trim().match(
      /^\d+\.\s+([0-9A-Fa-f]{12})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s+([YN])\b/,
    );
    if (!m || m.length < 7) continue;
    const macUpper = m[1]!.toUpperCase();
    out.set(macUpper, {
      mac: macUpper,
      ip: m[2]!,
      port: Number(m[5]),
      dhcp: m[6] === "Y",
      raw: {
        netmask: m[3]!,
        gateway: m[4]!,
      },
    });
  }
  return [...out.values()];
}

async function runWiznetDiscovery(): Promise<WiznetRecord[]> {
  return await new Promise((resolve) => {
    const child = spawn("sudo", ["-n", WIZNET_CLI, "-d"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (records: WiznetRecord[]) => {
      if (done) return;
      done = true;
      resolve(records);
    };
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      log.warn("wiznet-discovery: spawn failed", { err: e.message });
      finish([]);
    });
    child.on("exit", () => {
      if (stderr.trim()) log.debug("wiznet-discovery stderr", { stderr: stderr.slice(0, 200) });
      finish(parseWiznetCliOutput(stdout));
    });
    setTimeout(() => {
      if (done) return;
      log.warn("wiznet-discovery: timed out, killing child");
      child.kill("SIGTERM");
      finish([]);
    }, SCAN_TIMEOUT_MS);
  });
}

/**
 * Issue `wiznet-cli --ipconfig MAC --static-ip IP --static-gateway GW
 * --port PORT` to flip a DHCP-enabled bridge to a static lease at its
 * current IP. The bridge keeps the same address it already has — we're
 * not assigning a new one, just removing it from the DHCP pool so the
 * router can't move it later.
 *
 * Bridge accepts the config over UDP, writes NVRAM, and reboots its TCP
 * listener (clients reconnect ~5-10 s later). The agent's existing
 * watchdog handles the brief disconnect with no operator intervention.
 *
 * Tolerant of failure — the next discovery tick will see the bridge
 * still on DHCP and try again. The LOCK_ATTEMPTED set prevents tight
 * retry loops within a single agent process.
 */
async function lockBridgeStatic(record: WiznetRecord): Promise<boolean> {
  return await new Promise((resolve) => {
    const args = [
      "-n",
      WIZNET_CLI,
      "--ipconfig",
      record.mac,
      "--static-ip",
      record.ip,
      "--static-gateway",
      record.raw.gateway ?? "192.168.1.1",
      "--static-netmask",
      record.raw.netmask ?? "255.255.255.0",
      "--port",
      String(record.port),
    ];
    const child = spawn("sudo", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      log.warn("wiznet-discovery: lock spawn failed", { mac: record.mac, err: e.message });
      finish(false);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        log.warn("wiznet-discovery: lock returned non-zero", {
          mac: record.mac,
          ip: record.ip,
          code,
          stderr: stderr.trim().slice(0, 200),
        });
      }
      finish(code === 0);
    });
    setTimeout(() => {
      if (done) return;
      log.warn("wiznet-discovery: lock timed out, killing child", { mac: record.mac });
      child.kill("SIGTERM");
      finish(false);
    }, LOCK_TIMEOUT_MS);
  });
}

/**
 * Starts a periodic WIZnet-discovery loop. Returns a stop() that cancels it.
 */
export function startWiznetDiscovery(env: AgentEnv): () => void {
  let stopped = false;
  const intervalMs = DEFAULT_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    try {
      const records = await runWiznetDiscovery();
      if (records.length === 0) {
        log.debug("wiznet-discovery: no devices found");
        return;
      }
      log.info("wiznet-discovery", { count: records.length });

      // Auto-lock any DHCP-enabled bridge to its current IP. Every Carbon
      // reader should be on a static lease so a router reboot or DHCP
      // pool recycle can't move it out from under us. We lock to whatever
      // IP the bridge currently has — that's the address the operator
      // already commissioned in the WMS. One-shot per MAC per agent
      // process; retried on the next tick if the lock didn't take.
      const dhcpBridges = records.filter((r) => r.dhcp && !LOCK_ATTEMPTED.has(r.mac));
      for (const r of dhcpBridges) {
        LOCK_ATTEMPTED.add(r.mac);
        log.info("wiznet-discovery: auto-locking bridge to static", {
          mac: r.mac,
          ip: r.ip,
          gateway: r.raw.gateway,
        });
        const ok = await lockBridgeStatic(r);
        if (!ok) {
          // Lock failed — drop from set so a future tick can retry once
          // the bridge is reachable again.
          LOCK_ATTEMPTED.delete(r.mac);
        }
      }

      const result = await postWiznetDiscoveries(env, {
        discoveries: records.map((r) => ({
          mac: r.mac,
          ip: r.ip,
          port: r.port,
          dhcp: r.dhcp,
          raw: r.raw,
        })),
      });
      if (result.ip_updated > 0 || result.new_discoveries > 0) {
        log.info("wiznet-discovery: server response", result);
      }
    } catch (e) {
      log.warn("wiznet-discovery: tick failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // First tick after a short delay so the agent is fully reconciled before
  // we start poking at the LAN with sudo.
  setTimeout(() => void tick(), 30_000);
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
