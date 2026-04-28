import type { AgentEnv } from "./config.js";
import { AGENT_VERSION, effectiveHostname } from "./config.js";
import { postHeartbeat } from "./wms-client.js";
import { log } from "./log.js";

/**
 * Starts a periodic heartbeat loop. Returns a stop() that cancels it.
 * The loop reports degraded status (rather than online) if the last config
 * pull failed, so the WMS dashboard can flag the agent.
 */
export function startHeartbeat(
  env: AgentEnv,
  isDegraded: () => boolean,
): () => void {
  const intervalMs = env.CARBON_HEARTBEAT_INTERVAL_SEC * 1000;
  const host = effectiveHostname(env);

  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await postHeartbeat(env, {
        agentVersion: AGENT_VERSION,
        hostname: host,
        status: isDegraded() ? "degraded" : "online",
      });
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
