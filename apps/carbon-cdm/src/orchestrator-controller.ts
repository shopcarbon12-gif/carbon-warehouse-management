import { spawn } from "node:child_process";
import { log } from "./log.js";
import type { AgentConfigBundle } from "./wms-client.js";
import { renderReadersJson } from "./readers-json.js";

/**
 * Talks to the legacy orchestrator process running under
 * carbon-cdm-orchestrator.service. We don't run the binary ourselves —
 * systemd does — so we restart it via systemctl when readers.json changes
 * and we hit its HTTP API to trigger pull/start sessions per reader.
 *
 * cdm's HTTP routes (discovered by inspecting the binary):
 *   POST /api/pull/start/{location}/{deviceId}/{clientId}/{trxnType}
 *   POST /api/pull/stop/{location}/{deviceId}
 *   POST /api/pull/clear/{location}/{deviceId}
 *
 * `transactionType` is a uint. We use 0 ("scan into a transfer") which
 * makes cdm spawn the configured driver (MonsoonReader / rfidapi) and
 * stream reads at the configured endpoint_url. The action=1 row in
 * cdm.db keeps cdm aware that the reader should remain online; the
 * /api/pull/start call kicks off the actual driver subprocess.
 */

const ORCHESTRATOR_UNIT = "carbon-cdm-orchestrator.service";
const ORCHESTRATOR_HTTP = "http://127.0.0.1:8888";
const CLIENT_ID = "carbon-cdm-agent";
const TRANSACTION_TYPE = 0;

function runSystemctl(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    // Absolute path so it matches the sudoers entry (see bootstrap script).
    const child = spawn("sudo", ["-n", "/bin/systemctl", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", () => resolve({ ok: false, stderr: "spawn failed" }));
    child.on("exit", (code) => resolve({ ok: code === 0, stderr }));
  });
}

export async function restartOrchestrator(): Promise<void> {
  log.info("restarting orchestrator", { unit: ORCHESTRATOR_UNIT });
  const r = await runSystemctl(["restart", ORCHESTRATOR_UNIT]);
  if (!r.ok) {
    log.warn("orchestrator restart returned non-zero", { stderr: r.stderr.trim().slice(0, 400) });
  }
}

export async function isOrchestratorActive(): Promise<boolean> {
  const r = await runSystemctl(["is-active", "--quiet", ORCHESTRATOR_UNIT]);
  return r.ok;
}

async function pullCmd(
  verb: "start" | "stop" | "clear",
  locationId: string,
  deviceId: number,
): Promise<boolean> {
  const tail = verb === "start"
    ? `/${encodeURIComponent(CLIENT_ID)}/${TRANSACTION_TYPE}`
    : "";
  const url = `${ORCHESTRATOR_HTTP}/api/pull/${verb}/${encodeURIComponent(locationId)}/${deviceId}${tail}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      log.info(`pull/${verb} ok`, { url, status: res.status });
      return true;
    }
    const body = await res.text().catch(() => "");
    log.warn(`pull/${verb} non-2xx`, { url, status: res.status, body: body.slice(0, 200) });
    return false;
  } catch (e) {
    log.warn(`pull/${verb} fetch failed`, {
      url,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Trigger START for every reader in the bundle. Idempotent — cdm rejects
 * a second start for a reader that's already running.
 */
export async function startAllReaders(bundle: AgentConfigBundle): Promise<void> {
  const desired = renderReadersJson(bundle);
  const locationCode = bundle.agent.location_code;
  for (const r of desired) {
    await pullCmd("start", locationCode, r.deviceId);
  }
}

export async function stopAllReaders(bundle: AgentConfigBundle | null): Promise<void> {
  if (!bundle) return;
  const desired = renderReadersJson(bundle);
  const locationCode = bundle.agent.location_code;
  for (const r of desired) {
    await pullCmd("stop", locationCode, r.deviceId);
  }
}
