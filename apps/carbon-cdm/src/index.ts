import { loadConfig, AGENT_VERSION, effectiveHostname } from "./config.js";
import { log, setLogLevel } from "./log.js";
import {
  fetchAgentConfig,
  type AgentConfigBundle,
} from "./wms-client.js";
import { startHeartbeat } from "./heartbeat.js";
import { ReadAggregator } from "./read-aggregator.js";
import { MonsoonSupervisor } from "./monsoon-supervisor.js";
import { AntennaTestController } from "./antenna-test-mode.js";
import { postAntennaTestResult } from "./wms-client.js";
import { startWiznetDiscovery } from "./wiznet-discovery.js";

const MONSOON_BINARY = "/opt/legacy-rfid/MonsoonReader";
/** 2024 Mojix binary; selected per-reader via devices.config.monsoon_driver = "console". */
const MONSOON_CONSOLE_BINARY = "/opt/legacy-rfid/new_monsoonreader";

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

  const aggregator = new ReadAggregator(env);
  aggregator.start();

  // Antenna-test controller — owns the per-reader TEST_MODE override that
  // the operator-driven /antenna-test page imposes. Polls WMS every 1 s for
  // active sessions; reads from a TEST_MODE child go through THIS module's
  // 100 ms micro-batcher straight to /api/antenna-test/ingest (no DB write,
  // no normal-scan aggregator).
  const antennaTest = new AntennaTestController(env);

  // Native MonsoonReader supervisor — bypasses Senitron's `cdm` middleware
  // (which doesn't talk to MonsoonReader correctly in our deployment) and
  // talks straight to the binary. EPCs come out of the supervisor already
  // parsed and deduped from the binary stream.
  const supervisor = new MonsoonSupervisor(
    { stream: MONSOON_BINARY, console: MONSOON_CONSOLE_BINARY },
    (read) => {
      aggregator.enqueue({
        readerId: read.readerId,
        reads: [
          {
            epcHex: read.epcHex,
            antennaNumber: read.antennaNumber ?? 1,
            rssiDbm: read.rssi ?? 0,
            monsoonTsMs: null,
          },
        ],
        receivedAt: new Date(read.readAt),
      });
    },
    // Antenna-test callback: post the result back to WMS so it can flip
    // the antenna's status_online and clear the test_pending_at flag.
    (result) => {
      void postAntennaTestResult(env, result).catch((e) => {
        log.warn("antenna test result post failed", {
          err: e instanceof Error ? e.message : String(e),
          antennaId: result.antennaId,
        });
      });
    },
  );

  // Two-way wiring: supervisor needs to push TEST_MODE reads into the
  // controller's micro-batcher; controller needs to ask supervisor to
  // enter/leave TEST_MODE in response to WMS-side session changes.
  supervisor.attachTestModeHandler((sessionId, read) => {
    antennaTest.recordRead(sessionId, read);
  });
  antennaTest.attachSupervisorHooks({
    enterTestMode: (s) => {
      supervisor.enterTestMode({
        readerId: s.readerId,
        sessionId: s.sessionId,
        antennaNumber: s.antennaNumber,
        powerArg: s.flags.powerArg,
        readTimeMs: s.flags.readTimeMs,
        cycleMode: s.flags.cycleMode,
        tagFocus: s.flags.tagFocus,
      });
    },
    leaveTestMode: (readerId) => supervisor.leaveTestMode(readerId),
  });
  antennaTest.start();

  let lastPullOk = false;
  const stopHeartbeat = startHeartbeat(env, () => !lastPullOk);
  const stopWiznetDiscovery = startWiznetDiscovery(env);

  const pullConfig = async () => {
    try {
      const bundle: AgentConfigBundle = await fetchAgentConfig(env);
      lastPullOk = true;
      log.info("config pulled", {
        agent: bundle.agent.name,
        location: bundle.agent.location_code,
        readers: bundle.readers.length,
      });
      supervisor.reconcile(bundle);
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
    const s = aggregator.getStats();
    log.info("ingest stats", s);
  }, 30_000);

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    clearInterval(pollHandle);
    clearInterval(statsHandle);
    stopHeartbeat();
    stopWiznetDiscovery();
    antennaTest.stop();
    aggregator.stop();
    supervisor.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
