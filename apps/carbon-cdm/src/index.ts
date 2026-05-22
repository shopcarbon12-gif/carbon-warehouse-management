import { spawn } from "node:child_process";
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
import { postAntennaTestResult, postReaderOnline, postReaderOffline } from "./wms-client.js";
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
    // Reader-online callback: fires the first time a child binary
    // produces ANY byte from the chassis after the slot has been in
    // offline state. Tells the WMS the reader is reachable so its
    // dashboard tile flips online — even before any tag reads land in
    // the inventory pipeline. Gated to fire only on offline→online
    // transitions, so back-to-back respawns don't re-push the same state.
    (readerId) => {
      void postReaderOnline(env, readerId).catch((e) => {
        log.debug("reader-online post failed (will retry on next spawn)", {
          readerId,
          err: e instanceof Error ? e.message : String(e),
        });
      });
    },
    // Reader-offline callback: fires when the silence watchdog detects
    // the chip has gone silent (>=60 s zero bytes). Tells the WMS to
    // flip status_online=false promptly. Agent-side throttle (~once per
    // minute per slot) prevents endpoint hammering on chronically-silent
    // readers; the periodic re-push self-heals stuck server-side rows
    // even if a previous agent run crashed before reporting offline.
    (readerId) => {
      void postReaderOffline(env, readerId).catch((e) => {
        log.debug("reader-offline post failed (will retry on next watchdog tick)", {
          readerId,
          err: e instanceof Error ? e.message : String(e),
        });
      });
    },
    // Reader-removed callback: supervisor pruned the slot during reconcile.
    // Drop the aggregator queue so buffered reads for a removed/paused
    // reader don't sit retrying against /api/cdm-agents/reads forever.
    (readerId) => aggregator.flushAndDrop(readerId),
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
    setActiveScanSessionReaders: (readerIds) =>
      supervisor.setActiveScanSessionReaders(readerIds),
  });
  antennaTest.start();

  // Startup orphan-sweep. If the previous agent process crashed or was
  // SIGKILL'd, it can leave MonsoonReader / new_monsoonreader / wiznet-cli
  // grandchildren alive. Those orphans keep TCP sockets open to WIZnet
  // bridges (SERVER(2) = single-client) and block the fresh supervisor
  // from connecting — every new spawn returns `cleanExit:true,
  // totalRecords:0` in ~300 ms. Live 2026-05-21 on POS reader: an orphan
  // `MonsoonReader --stop` had held the .69 bridge socket for 13 min
  // through an agent restart. `pkill -9 -f <abs path>` reaps them.
  await sweepLegacyOrphans();

  let lastPullOk = false;
  const stopHeartbeat = startHeartbeat(
    env,
    () => !lastPullOk,
    () => supervisor.getWedgedReaders(),
    () => supervisor.getPowerSuggestions(),
  );
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

async function sweepLegacyOrphans(): Promise<void> {
  // Patterns are absolute paths so `pkill -f` can't match the supervisor's
  // own argv or shell command lines that mention the binary name.
  const patterns = [
    "/opt/legacy-rfid/MonsoonReader",
    "/opt/legacy-rfid/new_monsoonreader",
    "/opt/legacy-rfid/wiznet-cli",
  ];
  await Promise.all(patterns.map((pat) => {
    return new Promise<void>((resolve) => {
      const child = spawn("sudo", ["pkill", "-9", "-f", pat], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        resolve();
      }, 3_000);
      child.on("exit", () => { clearTimeout(t); resolve(); });
      child.on("error", () => { clearTimeout(t); resolve(); });
    });
  }));
  log.info("startup: orphan sweep complete", { patterns });
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
