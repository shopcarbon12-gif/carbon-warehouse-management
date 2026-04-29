import { loadConfig, AGENT_VERSION, effectiveHostname } from "./config.js";
import { log, setLogLevel } from "./log.js";
import {
  fetchAgentConfig,
  type AgentConfigBundle,
  type AgentConfigReader,
} from "./wms-client.js";
import { startHeartbeat } from "./heartbeat.js";
import { ReadAggregator } from "./read-aggregator.js";
import { startCdmBridge, type IncomingTagRead } from "./cdm-bridge.js";
import { writeReadersJsonIfChanged } from "./readers-json.js";
import { syncReadersToCdmDb } from "./cdm-db.js";
import {
  restartOrchestrator,
  isOrchestratorActive,
  startAllReaders,
  stopAllReaders,
} from "./orchestrator-controller.js";

const READERS_JSON_PATH = "/opt/legacy-rfid/runtime/readers.json";

/**
 * Pick which reader+antenna a tag-read came from, based on its antenna_id
 * field (set by the legacy orchestrator) and our current config bundle.
 *
 * Today we use a simple heuristic: if there's exactly one reader, route
 * everything to it. With multiple readers we match the trailing digit of
 * antenna_id against an antenna_number under each reader. A more robust
 * mapping (use deviceId prefix from readers.json) lands when fleet size
 * grows beyond ~3.
 */
function routeRead(
  read: IncomingTagRead,
  bundle: AgentConfigBundle,
): { reader: AgentConfigReader; antennaNumber?: number } | null {
  if (bundle.readers.length === 0) return null;
  if (bundle.readers.length === 1) {
    return {
      reader: bundle.readers[0]!,
      antennaNumber: read.antennaNumber,
    };
  }
  // Multi-reader: try to match antenna_number against any reader's antenna list.
  if (read.antennaNumber !== undefined) {
    for (const r of bundle.readers) {
      if (r.antennas.some((a) => a.antenna_number === read.antennaNumber)) {
        return { reader: r, antennaNumber: read.antennaNumber };
      }
    }
  }
  // Fall back: first reader, no antenna attribution.
  return { reader: bundle.readers[0]!, antennaNumber: read.antennaNumber };
}

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

  let currentBundle: AgentConfigBundle | null = null;

  const aggregator = new ReadAggregator(env);
  aggregator.start();

  const bridge = startCdmBridge({
    onReads: (reads: IncomingTagRead[]) => {
      if (!currentBundle) return;
      // Group by destination readerId so we can post in batches per reader.
      const byReader = new Map<string, { antennaNumber?: number; epcHex: string; rssi?: number; readAt?: string }[]>();
      for (const r of reads) {
        const route = routeRead(r, currentBundle);
        if (!route) continue;
        const key = route.reader.id;
        const arr = byReader.get(key) ?? [];
        arr.push({
          epcHex: r.epcHex,
          ...(route.antennaNumber !== undefined ? { antennaNumber: route.antennaNumber } : {}),
          ...(r.rssi !== undefined ? { rssi: r.rssi } : {}),
          ...(r.readAt ? { readAt: r.readAt } : {}),
        });
        byReader.set(key, arr);
      }
      for (const [readerId, items] of byReader) {
        aggregator.enqueue({
          readerId,
          reads: items.map((it) => ({ epcHex: it.epcHex, monsoonTsMs: null })),
          receivedAt: new Date(),
        });
      }
    },
  });

  let lastPullOk = false;
  const stopHeartbeat = startHeartbeat(env, () => !lastPullOk);

  const pullConfig = async () => {
    try {
      const bundle = await fetchAgentConfig(env);
      lastPullOk = true;
      currentBundle = bundle;
      log.info("config pulled", {
        agent: bundle.agent.name,
        location: bundle.agent.location_code,
        readers: bundle.readers.length,
      });

      const fileChanged = await writeReadersJsonIfChanged(READERS_JSON_PATH, bundle);
      // The cdm.db readers table is the actual source of truth for cdm's
      // auto-start loop — readers.json is just a sidecar Athena used to dump
      // for human inspection. Sync the sqlite even when the JSON didn't move
      // (e.g. on first boot before the agent has ever written anything).
      const dbChanged = await syncReadersToCdmDb(bundle);

      let restarted = false;
      if (fileChanged || dbChanged) {
        log.info("reader config changed — restarting orchestrator", {
          fileChanged,
          dbChanged,
        });
        await restartOrchestrator();
        restarted = true;
      } else {
        // If orchestrator isn't running for some reason, kick it.
        const active = await isOrchestratorActive();
        if (!active) {
          log.warn("orchestrator not active — starting it");
          await restartOrchestrator();
          restarted = true;
        }
      }
      if (restarted) {
        // cdm needs ~4s after launch to bind its HTTP listener. Then we
        // POST /api/pull/start for each reader to kick off the driver.
        // The action=1 row in cdm.db is necessary but not sufficient — cdm
        // only "checks" auto-start; the actual spawn fires on /api/pull/start.
        setTimeout(() => {
          void startAllReaders(bundle).catch((e) => {
            log.warn("startAllReaders failed", { err: e instanceof Error ? e.message : String(e) });
          });
        }, 4000);
      } else {
        // No restart but ensure reads are running. Cheap idempotent kick.
        void startAllReaders(bundle).catch(() => undefined);
      }
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
    aggregator.stop();
    bridge.close();
    void stopAllReaders(currentBundle).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // No boot-time START — cdm reads action=1 from cdm.db and auto-starts.
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
