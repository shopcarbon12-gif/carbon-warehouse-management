import { loadConfig, AGENT_VERSION, effectiveHostname } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { fetchAgentConfig } from "./wms-client.js";
import { startHeartbeat } from "./heartbeat.js";
import { ReaderSupervisor } from "./reader-supervisor.js";

async function main(): Promise<void> {
  const env = loadConfig();
  setLogLevel(env.CARBON_LOG_LEVEL);

  log.info("Carbon CDM agent starting", {
    version: AGENT_VERSION,
    wms: env.CARBON_WMS_URL,
    hostname: effectiveHostname(env),
    heartbeat_interval_sec: env.CARBON_HEARTBEAT_INTERVAL_SEC,
    config_poll_interval_sec: env.CARBON_CONFIG_POLL_INTERVAL_SEC,
  });

  const supervisor = new ReaderSupervisor(env);

  let lastPullOk = false;
  const stopHeartbeat = startHeartbeat(env, () => !lastPullOk);

  const pullConfig = async () => {
    try {
      const bundle = await fetchAgentConfig(env);
      lastPullOk = true;
      log.info("config pulled", {
        agent: bundle.agent.name,
        location: bundle.agent.location_code,
        readers: bundle.readers.length,
      });
      supervisor.reconcile(bundle.readers);
    } catch (e) {
      lastPullOk = false;
      log.error("config pull failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  };

  await pullConfig();
  const pollHandle = setInterval(
    pullConfig,
    env.CARBON_CONFIG_POLL_INTERVAL_SEC * 1000,
  );

  const statsHandle = setInterval(() => {
    const s = supervisor.stats();
    log.info("ingest stats", s);
  }, 30_000);

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    clearInterval(pollHandle);
    clearInterval(statsHandle);
    stopHeartbeat();
    supervisor.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive — the timers do the work.
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
