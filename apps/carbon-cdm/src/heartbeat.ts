import type { AgentEnv } from "./config.js";
import { AGENT_VERSION, effectiveHostname } from "./config.js";
import { postHeartbeat } from "./wms-client.js";
import { log } from "./log.js";

/**
 * Process boot time, captured at module load. Sent on every heartbeat so
 * the server can compare against `cdm_agents.recover_requested_at` and ask
 * us to exit when an admin has clicked the Recover button.
 */
const BOOT_TIME_ISO = new Date().toISOString();

/**
 * Starts a periodic heartbeat loop. Returns a stop() that cancels it.
 * The loop reports degraded status (rather than online) if the last config
 * pull failed, so the WMS dashboard can flag the agent.
 *
 * If the heartbeat response sets `restart_requested: true`, the agent
 * exits cleanly with code 0 and systemd's `Restart=always` respawns us
 * within RestartSec (5 seconds). This is how the WMS-side Recover button
 * triggers a fresh agent process to clear stuck supervisor state.
 */
export function startHeartbeat(
  env: AgentEnv,
  isDegraded: () => boolean,
  /** Snapshot of supervisor wedge-Level-3 readers, called each heartbeat
   *  so the WMS gets a fresh list of chassis that need physical service.
   *  Omit if the agent isn't running a supervisor (test harnesses, etc.). */
  getWedgedReaders?: () => { readerId: string; wedgedSinceMs: number }[],
  /** Snapshot of supervisor auto-sweep power suggestions (working power
   *  found below the operator-configured value). */
  getPowerSuggestions?: () => { readerId: string; suggestedDbm: number }[],
  /** Snapshot of POS readers currently in active recovery, so the WMS can set
   *  devices.recovery_state and the POS shows "Reader recovering…". */
  getRecoveringReaders?: () => {
    readerId: string;
    state: "recovering" | "hard_resetting";
    sinceMs: number;
  }[],
): () => void {
  const intervalMs = env.CARBON_HEARTBEAT_INTERVAL_SEC * 1000;
  const host = effectiveHostname(env);

  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await postHeartbeat(env, {
        agentVersion: AGENT_VERSION,
        hostname: host,
        status: isDegraded() ? "degraded" : "online",
        bootTimeIso: BOOT_TIME_ISO,
        wedgedReaders: getWedgedReaders?.() ?? [],
        powerSuggestions: getPowerSuggestions?.() ?? [],
        recoveringReaders: getRecoveringReaders?.() ?? [],
      });
      if (r.restart_requested) {
        log.warn("heartbeat: restart_requested by server — exiting (systemd will respawn)", {
          bootTime: BOOT_TIME_ISO,
        });
        stopped = true;
        // 250 ms grace lets the log line flush + lets any in-flight HTTP
        // body finish writing before systemd kills the parent.
        setTimeout(() => process.exit(0), 250);
      }
    } catch (e) {
      log.warn("heartbeat failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  };

  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
