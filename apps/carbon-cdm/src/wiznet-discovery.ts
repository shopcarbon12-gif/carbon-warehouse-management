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

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const WIZNET_CLI = "/opt/legacy-rfid/wiznet-cli";
const SCAN_TIMEOUT_MS = 15_000;

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
