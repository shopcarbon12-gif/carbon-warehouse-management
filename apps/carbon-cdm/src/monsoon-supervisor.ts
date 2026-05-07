import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { log } from "./log.js";
import type { AgentConfigBundle, AgentConfigReader } from "./wms-client.js";
import {
  parseStream,
  newParserState,
  type ParserState,
} from "./stream-parser.js";
import {
  parseConsoleChunk,
  newConsoleParserState,
  type ConsoleParserState,
} from "./console-parser.js";

/** Paths to the two Mojix binaries we know how to drive. */
export type MonsoonBinaries = {
  /** 2019 `MonsoonReader` — TCP `--stream` socket, 50-byte binary records. */
  stream: string;
  /** 2024 `new_monsoonreader` — text stdout, one read per line, CRC filtered. */
  console: string;
};

/**
 * Drives the legacy MonsoonReader binary directly — bypasses Senitron's
 * `cdm` middleware entirely. Senitron's cdm is supposed to glue
 * MonsoonReader's binary stream to whatever endpoint we configure, but in
 * our deployment cdm and MonsoonReader can't agree on direction (both
 * think they're the server, neither connects to the other) and no reads
 * ever flow.
 *
 * Stream framing: MonsoonReader emits a 5-byte Boost-archive header on
 * connect, then fixed 50-byte tag-read records (marker `0x31 0x00`, EPC at
 * offset 26 with length from byte 3, antenna number at byte 9). All EPCs
 * are forwarded regardless of prefix; SGTIN decoding happens server-side
 * via tenant_epc_config. See stream-parser.ts for the full record layout.
 *
 * One MonsoonReader subprocess per reader. We restart any process that
 * dies, but with a backoff so a misconfigured reader can't pin a CPU.
 */

const STREAM_PORT_BASE = 30100;   // MonsoonReader --stream port for reader 0; +N per extra reader
const CONTROL_PORT_BASE = 20100;  // MonsoonReader --control port; +N per extra reader
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * Candidate Monsoon-over-Ethernet ports. The first time a reader spawns
 * we use the operator-configured port; if the resulting child stays silent
 * (zero bytes before the watchdog kicks at STREAM_SILENCE_TIMEOUT_MS), we
 * rotate to the next candidate. Operator never needs to know which port
 * their WIZnet bridge is on — adding the reader's IP is enough.
 *   10002 — Senitron-configured WIZnet factory image
 *    1461 — WIZnet WIZ100SR/110SR/140SR factory default data-tunnel port
 */
const SERIAL_PORT_FALLBACKS: readonly number[] = [10002, 1461];

function buildCandidatePorts(configured: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const p of [configured, ...SERIAL_PORT_FALLBACKS]) {
    if (!Number.isFinite(p) || p <= 0) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.length > 0 ? out : [10002];
}
// Per-(epc, antenna) suppression DISABLED. Empirically the binary flushes
// its inventory in a single ~22ms-wide burst of 100s of records (each
// tag reported 5-6 times back-to-back, one per recently-completed cycle).
// Any dedup window past zero collapses that burst into a single read per
// tag, which matches "first seen" but starves the live-scan tile of the
// repeating reads it shows as activity. The WMS does its own dedup at
// ingest, so emitting every record is safe.
const DEDUP_WINDOW_MS = 0;

export type SupervisorReadHandler = (read: {
  readerId: string;
  epcHex: string;
  antennaNumber?: number;
  rssi?: number;
  readAt: string;
}) => void;

type ReaderSlot = {
  spec: AgentConfigReader;
  index: number;
  streamPort: number;
  controlPort: number;
  child: ChildProcess | null;
  streamSocket: net.Socket | null;
  buffer: Buffer;
  parserState: ParserState;
  /** Per-(epc,antenna) last-seen ms timestamp for short dedupe window. */
  lastSeen: Map<string, number>;
  backoffMs: number;
  shuttingDown: boolean;
  /**
   * Index into the candidate-port list (configured port + fallbacks, dedup'd).
   * On every spawn we use `candidatePorts[candidatePortIdx]`. If a spawn
   * produces zero bytes before the watchdog kicks it, we advance this index
   * and try the next port — that's how a freshly-installed reader on the
   * WIZnet factory port (1461) ends up working without operator intervention
   * even when the WMS config still says 10002.
   */
  candidatePorts: number[];
  candidatePortIdx: number;
  /**
   * Has any byte ever arrived on the stream socket since this child was
   * spawned? Set to true on first byte. Watchdog uses this to decide
   * whether to rotate ports (no bytes ever = wrong port) or just respawn
   * (bytes arrived = right port, just hung).
   */
  bytesSinceSpawn: boolean;
  /**
   * Consecutive watchdog-kicks that produced zero bytes. Reset to 0 the
   * moment a byte arrives. After we've kicked once per candidate port
   * (i.e. >= candidatePorts.length) without ever hearing back, we stop
   * rotating and back off the watchdog so a truly unreachable reader
   * doesn't spam the log forever.
   */
  consecutiveZeroByteKicks: number;
  /**
   * ms timestamp of the last time we either entered the exhausted state OR
   * reset the exhausted state for a re-probe. The watchdog uses this to
   * periodically clear `consecutiveZeroByteKicks` so a reader that comes
   * back online (after a power-cycle, network hiccup, or transient stall)
   * recovers without operator intervention.
   */
  lastExhaustionResetAt: number;
  /** ms timestamp of the most recent byte arrival on streamSocket. The
   *  watchdog uses this to detect a "stuck but alive" MonsoonReader — the
   *  binary occasionally enters a state where the process is up, the stream
   *  socket is connected, but no inventory bytes ever arrive. We force a
   *  respawn after STREAM_SILENCE_TIMEOUT_MS of zero traffic. */
  lastByteAt: number;
  /** ms timestamp of the most recent PARSED tag-read record. Different from
   *  lastByteAt because a stuck binary can still drip non-record bytes
   *  (status / heartbeat lines) while producing zero tag reads — the silence
   *  watchdog won't fire but rate-drop will. 0 = no records ever seen. */
  lastRecordAt: number;
  /**
   * Active antenna-test windows for THIS reader, keyed by antenna_id (the
   * WMS-side UUID). Counts are incremented only for stream records whose
   * `antennaNumber` byte matches the antenna's `antenna_number`, so each
   * antenna's TEST PASSED status reflects ITS own port (not the reader's
   * other antennas).
   */
  activeTests: Map<
    string,
    { antennaNumber: number; startedAt: number; epcCount: number; expiresAt: number }
  >;
  /**
   * Driver actually used for the most recent spawn. Settled at spawn time
   * from `spec.monsoon_driver`; stored on the slot so reconcile can detect
   * a driver flip in the WMS config and force a respawn cleanly.
   */
  currentDriver: "stream" | "console";
  /** Console-mode parser state — only relevant when currentDriver === "console". */
  consoleParserState: ConsoleParserState;
  /** Antenna number stamped on every console-mode read (binary doesn't include it). */
  consoleStampAntenna: number;
  /**
   * If non-null, this slot is in TEST_MODE: the supervisor preempts the
   * reader's normal scan, spawns a single MonsoonReader (console driver
   * forced) configured against ONE antenna with operator-tunable flags,
   * and routes every parsed read to `onTestModeRead` instead of `onRead`.
   * Reverts to normal scan when set back to null.
   */
  testSession: TestModeSpec | null;
};

/** Operator-tunable knobs an active /antenna-test session imposes on a reader. */
export type TestModeSpec = {
  sessionId: string;
  antennaNumber: number;
  powerArg: number;
  readTimeMs: number;
  cycleMode: "infinite" | "oscillating";
  tagFocus: boolean;
};

/** Callback signature for routing TEST_MODE reads to the controller. */
export type TestModeReadHandler = (
  sessionId: string,
  read: {
    epcHex: string;
    rssiDbm: number;
    antennaNumber: number;
    observedAt: string;
    powerArg: number;
  },
) => void;

export type AntennaTestCallback = (result: {
  antennaId: string;
  foundAnyEpc: boolean;
  observedEpcCount: number;
  testStartedAt: string;
  testEndedAt: string;
}) => void;

/** Listen window length in ms. */
const TEST_WINDOW_MS = 30_000;
/** How often the supervisor sweeps active test windows for expiration. */
const TEST_SWEEP_INTERVAL_MS = 1_000;
/**
 * Force-respawn MonsoonReader if its stream socket has been silent for this
 * long. The binary occasionally enters a "alive but not streaming" state
 * after the initial inventory burst — process is up, socket is open, no
 * bytes arrive. Detected by comparing now() vs slot.lastByteAt.
 *
 * Threshold mirrors Senitron's cdm.json `read_timeout: 30` (their canonical
 * production setting), padded to 60s here because we don't inject the
 * FFE0A0… heartbeat EPCs Senitron uses to keep the stream non-silent during
 * quiet warehouse periods, so a 30s threshold would false-positive on real
 * idle. 60s is a compromise: catches stuck-but-alive within one minute,
 * tolerant of moderately quiet periods.
 */
const STREAM_SILENCE_TIMEOUT_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/**
 * Rate-drop watchdog. Catches the "alive but barely producing reads"
 * stuck state where the binary keeps the TCP socket up, occasionally
 * dribbles a status byte (so the silence watchdog never fires), but stops
 * emitting parsed tag-read records. Live evidence 2026-05-02: TEST3 sat
 * at exactly 501,767 posted reads for 15+ minutes with the socket
 * ESTABLISHED — strace showed zero stdout writes from the binary.
 *
 * We say a slot is "rate-dropped" if it produced records at some point
 * (lastRecordAt > 0) AND has produced none in this window. When tripped,
 * SIGTERM the child the same way the silence watchdog does so the on-exit
 * handler respawns it fresh.
 */
const READ_RATE_DROP_TIMEOUT_MS = 60_000;
/**
 * After a reader is declared exhausted (every candidate port tried, all
 * silent), wait this long before resetting the counter and probing again.
 * Without this, a reader that loses power for 30s and comes back stays
 * permanently dark from the agent's perspective until someone manually
 * restarts the agent — which is what happened on TEST3 the night of
 * 2026-05-02. 5 minutes is short enough that an operator power-cycle
 * recovers automatically, long enough that a truly-dead reader doesn't
 * spam logs every few seconds.
 */
const EXHAUSTION_RECOVERY_INTERVAL_MS = 5 * 60_000;

export class MonsoonSupervisor {
  private slots = new Map<string, ReaderSlot>();
  private bundleVersion = 0;
  private testSweepHandle: NodeJS.Timeout | null = null;
  private streamWatchdogHandle: NodeJS.Timeout | null = null;
  /** Set of antenna IDs we've already started a test for (one-shot per pending). */
  private testedAntennas = new Set<string>();

  /** Optional callback for routing TEST_MODE reads to the antenna-test
   *  controller. Set via attachTestModeHandler() after construction. */
  private onTestModeRead: TestModeReadHandler | null = null;

  constructor(
    private readonly binaries: MonsoonBinaries,
    private readonly onRead: SupervisorReadHandler,
    /**
     * Optional: receives antenna-test results when a test window closes.
     * Wire this to wms-client.postAntennaTestResult to push results
     * back to the WMS.
     */
    private readonly onAntennaTestResult: AntennaTestCallback | null = null,
  ) {
    if (this.onAntennaTestResult) {
      this.testSweepHandle = setInterval(
        () => this.sweepExpiredTests(),
        TEST_SWEEP_INTERVAL_MS,
      );
    }
    // Stream-silence watchdog RE-ENABLED 2026-05-01 after live evidence
    // showed --oscillating ALSO falls into the alive-but-not-streaming
    // stuck state (one inventory burst, then 30+ minutes of zero bytes).
    // Senitron's canonical cdm orchestrator has the same watchdog —
    // cdm.json `read_timeout: 30` + `respawn_timeouts: 2` + explicit
    // "MonsoonReader crashed / exited / Restarting" logic in their cdm
    // binary. The earlier "Senitron has no watchdog" assumption was based
    // on `cdm-watcher.service` being broken — that's a separate (unused)
    // service; the real watchdog is built into cdm itself.
    this.streamWatchdogHandle = setInterval(
      () => this.runStreamWatchdog(),
      WATCHDOG_INTERVAL_MS,
    );
  }

  private runStreamWatchdog(): void {
    const now = Date.now();
    for (const slot of this.slots.values()) {
      if (slot.shuttingDown) continue;
      if (!slot.child) continue;
      // Watchdog applies to BOTH drivers, but for different reasons:
      //   - stream driver: catches the alive-but-stuck silence bug.
      //   - console driver: catches "spawned with wrong serial port" — the
      //     binary stays silent because it can't reach the reader, then the
      //     watchdog kicks and the port-rotation logic advances candidate
      //     ports the same way it does in stream mode.
      // A healthy console driver emits continuously, so its lastByteAt is
      // always fresh and the watchdog never fires.
      // After we've kicked once per candidate port without hearing back
      // we stop watchdogging this slot — the reader is truly unreachable
      // (no radio behind the WIZnet, dead antennas, etc.) and rotating
      // again won't help. Let the on-exit respawn (with exp backoff) and
      // the next operator-side change in WMS config handle it.
      const totalCandidates = Math.max(1, slot.candidatePorts.length);
      let exhaustedAllPorts = slot.consecutiveZeroByteKicks >= totalCandidates;

      // Stamp the exhaustion timer on first entry so the recovery branch
      // doesn't fire instantly on a freshly-spun-up slot.
      if (exhaustedAllPorts && slot.lastExhaustionResetAt === 0) {
        slot.lastExhaustionResetAt = now;
      }
      // Periodic exhaustion recovery: if we've been in the exhausted state
      // for EXHAUSTION_RECOVERY_INTERVAL_MS, reset the counters and force
      // the next watchdog tick to re-probe from the configured port. Without
      // this, a reader that briefly went unreachable stays dark forever from
      // the agent's perspective — the on-exit respawn keeps producing silent
      // children that the exhausted-branch refuses to kick. Universal across
      // all readers (current and future).
      if (
        exhaustedAllPorts &&
        slot.lastExhaustionResetAt > 0 &&
        now - slot.lastExhaustionResetAt >= EXHAUSTION_RECOVERY_INTERVAL_MS
      ) {
        log.info("supervisor: exhaustion recovery — re-probing reader", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          host: slot.spec.network_address,
          stuckMs: now - slot.lastExhaustionResetAt,
        });
        slot.consecutiveZeroByteKicks = 0;
        slot.candidatePortIdx = 0;
        slot.bytesSinceSpawn = false;
        slot.lastExhaustionResetAt = now;
        exhaustedAllPorts = false;
        // Force a respawn so the next child is fresh on the configured port.
        slot.lastByteAt = now;
        slot.child?.kill("SIGTERM");
        continue;
      }

      const silentMs = now - slot.lastByteAt;
      if (silentMs >= STREAM_SILENCE_TIMEOUT_MS && !exhaustedAllPorts) {
        if (!slot.bytesSinceSpawn) {
          // Zero-byte kick: rotate to next candidate port if we have one.
          slot.consecutiveZeroByteKicks += 1;
          if (slot.candidatePorts.length > 1) {
            const prevIdx = slot.candidatePortIdx;
            slot.candidatePortIdx = (slot.candidatePortIdx + 1) % slot.candidatePorts.length;
            log.warn("supervisor: stream silent + zero bytes — rotating serial port", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              silentMs,
              prevPort: slot.candidatePorts[prevIdx],
              nextPort: slot.candidatePorts[slot.candidatePortIdx],
              kicksSoFar: slot.consecutiveZeroByteKicks,
              totalCandidates,
            });
          }
        } else {
          // Bytes did flow earlier; binary just hung. Plain respawn.
          log.warn("supervisor: stream silent — kicking MonsoonReader", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            silentMs,
          });
        }
        slot.lastByteAt = now;
        slot.child?.kill("SIGTERM");
      } else if (
        slot.lastRecordAt > 0 &&
        now - slot.lastRecordAt >= READ_RATE_DROP_TIMEOUT_MS
      ) {
        // Rate-drop: produced records earlier, none in the last window. The
        // binary went catatonic. Kick it; the on-exit handler respawns.
        log.warn("supervisor: read rate dropped to zero — kicking child", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          host: slot.spec.network_address,
          msSinceLastRecord: now - slot.lastRecordAt,
        });
        slot.lastRecordAt = 0;
        slot.lastByteAt = now;
        slot.child?.kill("SIGTERM");
      } else if (silentMs >= STREAM_SILENCE_TIMEOUT_MS && exhaustedAllPorts) {
        // We've tried every candidate port at least once without bytes.
        // Bump lastByteAt so we don't spam this branch every 5s — but
        // leave the child running and rely on on-exit respawn cycles
        // (which themselves are throttled by backoffMs). The periodic
        // recovery above will eventually clear the exhaustion and re-probe.
        if (!slot.bytesSinceSpawn) {
          // Only log once per long stretch. Stamp lastExhaustionResetAt
          // here too so the recovery timer starts from this moment.
          slot.lastByteAt = now;
          if (slot.lastExhaustionResetAt === 0) slot.lastExhaustionResetAt = now;
          log.warn("supervisor: reader unreachable, all candidate ports exhausted", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            host: slot.spec.network_address,
            triedPorts: slot.candidatePorts,
            recoveryInMs: Math.max(
              0,
              EXHAUSTION_RECOVERY_INTERVAL_MS - (now - slot.lastExhaustionResetAt),
            ),
          });
        }
      }
    }
  }

  /**
   * Reconcile the running set of MonsoonReader subprocesses against the
   * desired set described by `bundle`. Stops processes for readers that
   * left the bundle and starts processes for readers that joined.
   */
  reconcile(bundle: AgentConfigBundle): void {
    this.bundleVersion += 1;

    // Readers run continuously unless explicitly paused. The previous
    // design gated this on `bundle.live_scan_active`, which was driven by
    // the dashboard tile's 60-second session prune — meaning an idle
    // dashboard tab silently killed every reader and broke antenna tests.
    // Operator-driven OFF switches still work: per-reader pause + the
    // weekly schedule both flip `effective_paused`, and the tenant-wide
    // Pause-all + Hard-reset buttons cover bulk control. The dashboard
    // tile is now informational, not a kill switch.
    const desiredById = new Map(
      bundle.readers
        .filter((r) => !(r.effective_paused ?? false))
        .map((r) => [r.id, r] as const),
    );

    // Stop slots for readers no longer in the bundle.
    for (const [id, slot] of this.slots) {
      if (!desiredById.has(id)) {
        log.info("supervisor: reader removed, stopping", {
          readerId: id,
          name: slot.spec.name,
          reason: "left_bundle_or_paused",
        });
        this.stopSlot(slot);
        this.slots.delete(id);
      }
    }

    // Start (or update) slots ONLY for readers in the desired set. Iterating
    // bundle.readers directly here was the bug shipped on 2026-05-03:
    // pause/live-scan-inactive correctly killed children in the loop above,
    // then this loop respawned every reader because it ignored the filter.
    // desiredById already excludes paused readers and (when live_scan is
    // inactive) is empty.
    let nextIndex = this.slots.size;
    for (const spec of desiredById.values()) {
      const isMonsoon = !((spec.model ?? "").toLowerCase().includes("zebra"));
      if (!isMonsoon) {
        // Zebra readers are handled by a different driver — out of scope
        // for this supervisor.
        continue;
      }
      // Multi-antenna readers must run on the stream driver regardless of
      // the saved monsoon_driver — the console binary's text output omits
      // per-tag antenna numbers and would mis-attribute every read on a 2-
      // or 4-antenna reader. Mirror the override that lives in spawnReader.
      const enabledCount = spec.antennas.filter((a) => a.enabled).length;
      const desiredDriver: "stream" | "console" =
        enabledCount >= 2 ? "stream" : spec.monsoon_driver === "console" ? "console" : "stream";
      const existing = this.slots.get(spec.id);
      if (existing) {
        // If operator changed the configured serial port in WMS, rebuild
        // the candidate list and reset rotation so we re-test from scratch.
        if (existing.spec.monsoon_serial_port !== spec.monsoon_serial_port) {
          existing.candidatePorts = buildCandidatePorts(Number(spec.monsoon_serial_port));
          existing.candidatePortIdx = 0;
          existing.bytesSinceSpawn = false;
        }
        // Driver flip in WMS config → kill the current child and let the
        // on-exit handler respawn under the new driver.
        if (existing.currentDriver !== desiredDriver) {
          log.info("supervisor: driver flip detected, restarting reader", {
            readerId: spec.id,
            from: existing.currentDriver,
            to: desiredDriver,
          });
          existing.spec = spec;
          existing.consoleParserState = newConsoleParserState();
          existing.parserState = newParserState();
          existing.buffer = Buffer.alloc(0);
          existing.bytesSinceSpawn = false;
          existing.consecutiveZeroByteKicks = 0;
          existing.lastExhaustionResetAt = Date.now();
          if (existing.child && !existing.shuttingDown) existing.child.kill("SIGTERM");
          continue;
        }
        // Update the stored spec so any later ops see fresh power/antennas/etc.
        existing.spec = spec;
        // If subprocess is dead, restart cycle will pick it up.
        continue;
      }
      const idx = nextIndex++;
      const enabledForStamp = spec.antennas.find((a) => a.enabled);
      const slot: ReaderSlot = {
        spec,
        index: idx,
        streamPort: STREAM_PORT_BASE + idx,
        controlPort: CONTROL_PORT_BASE + idx,
        child: null,
        streamSocket: null,
        buffer: Buffer.alloc(0),
        parserState: newParserState(),
        lastSeen: new Map(),
        backoffMs: MIN_BACKOFF_MS,
        shuttingDown: false,
        activeTests: new Map(),
        lastByteAt: Date.now(),
        candidatePorts: buildCandidatePorts(Number(spec.monsoon_serial_port)),
        candidatePortIdx: 0,
        bytesSinceSpawn: false,
        consecutiveZeroByteKicks: 0,
        lastExhaustionResetAt: 0,
        lastRecordAt: 0,
        currentDriver: desiredDriver,
        consoleParserState: newConsoleParserState(),
        consoleStampAntenna: enabledForStamp?.antenna_number ?? 1,
        testSession: null,
      };
      this.slots.set(spec.id, slot);
      log.info("supervisor: starting reader", {
        readerId: spec.id,
        name: spec.name,
        ip: spec.network_address,
        streamPort: slot.streamPort,
        controlPort: slot.controlPort,
      });
      void this.spawnReader(slot);
    }

    // Sweep the bundle for antennas with pending tests we haven't started yet.
    if (this.onAntennaTestResult) {
      this.startPendingTests(bundle);
    }
  }

  /**
   * For every antenna in the bundle whose `test_pending_at` is set AND we
   * haven't already opened a window for this exact pending instance, open
   * a 30-sec listen window on the parent reader's slot. The byte-stream
   * consumer will increment `epcCount` for the antenna's window every time
   * it sees an EPC. When `sweepExpiredTests` notices the window expired,
   * it emits the result via `onAntennaTestResult` and the WMS updates the
   * antenna's status_online from there.
   */
  private startPendingTests(bundle: AgentConfigBundle): void {
    const now = Date.now();
    for (const reader of bundle.readers) {
      const slot = this.slots.get(reader.id);
      if (!slot) continue; // reader not running, can't test
      for (const ant of reader.antennas) {
        if (!ant.test_pending_at) continue;
        // Idempotency key — same antenna + same trigger timestamp = same test.
        const testKey = `${ant.id}@${ant.test_pending_at}`;
        if (this.testedAntennas.has(testKey)) continue;
        this.testedAntennas.add(testKey);
        slot.activeTests.set(ant.id, {
          antennaNumber: ant.antenna_number,
          startedAt: now,
          epcCount: 0,
          expiresAt: now + TEST_WINDOW_MS,
        });
        log.info("supervisor: antenna test window opened", {
          antennaId: ant.id,
          readerId: reader.id,
          windowMs: TEST_WINDOW_MS,
        });
      }
    }

    // Garbage-collect testedAntennas cache so it doesn't grow forever.
    // Keep only entries for tests still pending — once test_pending_at is
    // cleared by the WMS (after we post the result), the next bundle
    // refresh won't have the matching key, and the entry is safe to drop.
    if (this.testedAntennas.size > 1000) {
      const stillPending = new Set<string>();
      for (const reader of bundle.readers) {
        for (const ant of reader.antennas) {
          if (ant.test_pending_at) stillPending.add(`${ant.id}@${ant.test_pending_at}`);
        }
      }
      for (const key of this.testedAntennas) {
        if (!stillPending.has(key)) this.testedAntennas.delete(key);
      }
    }
  }

  /**
   * Tick: for each slot, find antenna-test windows that have reached
   * their `expiresAt`. For each, emit a result via `onAntennaTestResult`
   * and remove the window.
   */
  private sweepExpiredTests(): void {
    if (!this.onAntennaTestResult) return;
    const now = Date.now();
    for (const slot of this.slots.values()) {
      for (const [antennaId, win] of slot.activeTests) {
        if (now < win.expiresAt) continue;
        const result = {
          antennaId,
          foundAnyEpc: win.epcCount > 0,
          observedEpcCount: win.epcCount,
          testStartedAt: new Date(win.startedAt).toISOString(),
          testEndedAt: new Date(now).toISOString(),
        };
        try {
          this.onAntennaTestResult(result);
        } catch (e) {
          log.warn("supervisor: onAntennaTestResult threw", {
            err: e instanceof Error ? e.message : String(e),
          });
        }
        slot.activeTests.delete(antennaId);
        log.info("supervisor: antenna test window closed", {
          antennaId,
          readerId: slot.spec.id,
          foundAnyEpc: result.foundAnyEpc,
          count: result.observedEpcCount,
        });
      }
    }
  }

  /** Wire the controller's recordRead. Called once at agent startup. */
  attachTestModeHandler(handler: TestModeReadHandler): void {
    this.onTestModeRead = handler;
  }

  /**
   * Enter TEST_MODE for the reader matching `spec.readerId`. Preempts the
   * reader's normal scan: kills the current child, spawn loop respawns
   * under the test flags. Idempotent: a second call with identical flags
   * is a no-op; with different flags, kills+respawns under new flags.
   */
  enterTestMode(spec: TestModeSpec & { readerId: string }): void {
    const slot = this.slots.get(spec.readerId);
    if (!slot) {
      log.warn("supervisor: enterTestMode for unknown reader", { readerId: spec.readerId });
      return;
    }
    const prior = slot.testSession;
    const flagsEqual =
      prior !== null &&
      prior.sessionId === spec.sessionId &&
      prior.antennaNumber === spec.antennaNumber &&
      prior.powerArg === spec.powerArg &&
      prior.readTimeMs === spec.readTimeMs &&
      prior.cycleMode === spec.cycleMode &&
      prior.tagFocus === spec.tagFocus;
    if (flagsEqual) return;
    slot.testSession = {
      sessionId: spec.sessionId,
      antennaNumber: spec.antennaNumber,
      powerArg: spec.powerArg,
      readTimeMs: spec.readTimeMs,
      cycleMode: spec.cycleMode,
      tagFocus: spec.tagFocus,
    };
    log.info("supervisor: enterTestMode — killing child to respawn under test flags", {
      readerId: spec.readerId,
      sessionId: spec.sessionId,
    });
    if (slot.child && !slot.shuttingDown) slot.child.kill("SIGTERM");
  }

  /** Leave TEST_MODE for the given reader; the on-exit respawn picks up
   *  the normal flags via the regular spawn path. */
  leaveTestMode(readerId: string): void {
    const slot = this.slots.get(readerId);
    if (!slot) return;
    if (!slot.testSession) return;
    log.info("supervisor: leaveTestMode — reverting to normal scan", { readerId });
    slot.testSession = null;
    if (slot.child && !slot.shuttingDown) slot.child.kill("SIGTERM");
  }

  shutdown(): void {
    if (this.testSweepHandle) {
      clearInterval(this.testSweepHandle);
      this.testSweepHandle = null;
    }
    if (this.streamWatchdogHandle) {
      clearInterval(this.streamWatchdogHandle);
      this.streamWatchdogHandle = null;
    }
    for (const slot of this.slots.values()) {
      slot.shuttingDown = true;
      this.stopSlot(slot);
    }
    this.slots.clear();
  }

  private avgPower(spec: AgentConfigReader): number {
    const enabled = spec.antennas.filter((a) => a.enabled);
    if (enabled.length === 0) return 30;
    return enabled.reduce((s, a) => s + a.transmit_power_dbm, 0) / enabled.length;
  }

  private spawnReader(slot: ReaderSlot): void {
    if (slot.shuttingDown) return;
    // TEST_MODE forces the console driver — the stream binary's bursty
    // alive-but-stuck behaviour would defeat the live-feedback UX of the
    // /antenna-test page. The new_monsoonreader is on the VM regardless
    // of the reader's saved monsoon_driver.
    //
    // Multi-antenna readers ALSO force the stream driver, regardless of
    // the WMS-saved preference. The console binary's text output doesn't
    // include per-tag antenna numbers (every record would be stamped with
    // a single antennaNumber), so all reads on a 2-antenna reader would
    // credit only one antenna in the per-antenna dashboard panel. The
    // stream binary's 50-byte record format includes the antenna at byte 9
    // and the parser already routes it through; combined with `--cmux
    // --mxa N1,N2,...` the binary's hardware mux cycles through every
    // enabled port, giving correct attribution per tag.
    const enabledAntennaCount = slot.spec.antennas.filter((a) => a.enabled).length;
    const desired: "stream" | "console" =
      slot.testSession !== null
        ? "console"
        : enabledAntennaCount >= 2
          ? "stream"
          : slot.spec.monsoon_driver === "console"
            ? "console"
            : "stream";
    slot.currentDriver = desired;
    if (desired === "console") {
      this.spawnReaderConsole(slot);
      return;
    }
    const { spec } = slot;
    const powerArg = Math.round(this.avgPower(spec) * 10);

    // Pick the current candidate serial port. The candidate list is
    // [configured, ...fallbacks] dedup'd. On every fresh spawn we use the
    // current index; if the spawn doesn't produce any stream bytes before
    // the watchdog kicks it (slot.bytesSinceSpawn stays false), the kick
    // path advances the index so the next spawn tries the next port.
    // This is how a freshly-installed reader on the WIZnet factory port
    // (1461) ends up working without operator intervention even when the
    // WMS config still says 10002 — we just spawn, observe silence, rotate.
    const host = String(spec.network_address ?? "");
    const serialPort =
      slot.candidatePorts[slot.candidatePortIdx] ??
      slot.candidatePorts[0] ??
      Number(spec.monsoon_serial_port);
    slot.bytesSinceSpawn = false;
    // Antenna selection. The legacy MonsoonReader has three distinct modes:
    //   1. Single antenna (port 1): omit `-a` and `--cmux` entirely. Binary
    //      defaults to antenna 1.
    //   2. Single antenna (port 2-N): pass `-a N`. Binary scans only that port.
    //   3. Multiple antennas: pass `--cmux --mxa N1,N2,...`. Binary's hardware
    //      multiplexer cycles through every listed port and stamps each tag
    //      with its source antenna in the 50-byte stream record (byte 9). The
    //      stream parser surfaces this as `rec.antennaNumber`, which the
    //      consumer routes to the matching dashboard tile.
    //
    // `--cmux` is "Enable mux via the reader GPIO pins" per the binary's
    // own --help. `--mux_cycles` defaults to -1 (infinite), which pairs
    // correctly with our `--infinite` cycle mode.
    const enabledAntennas = spec.antennas.filter((a) => a.enabled);
    const antennaArgs: string[] = [];
    if (enabledAntennas.length >= 2) {
      antennaArgs.push(
        "--cmux",
        "--mxa",
        enabledAntennas.map((a) => a.antenna_number).join(","),
      );
    } else if (enabledAntennas.length === 1 && enabledAntennas[0]!.antenna_number !== 1) {
      antennaArgs.push("-a", String(enabledAntennas[0]!.antenna_number));
    }
    const args = [
      "--num", "1",
      // NOTE: `--cstream` was being passed historically (it appears in
      // Senitron's readers.json) — but in this binary `--cstream` is a
      // "Remote Exclusive" flag intended for a CLIENT consuming from a
      // remote Monsoon over `--monsoon_host`. In our Serial-Reader-mode
      // setup it has the side effect of suppressing the live --stream
      // output: the binary flushes its in-memory cache once on connect,
      // then stays silent. Verified live 2026-05-01 by toggling the flag
      // in isolation: with --cstream, 0 bytes after the initial flush;
      // without --cstream, ~330 bytes/sec of continuous record output.
      "--stream", String(slot.streamPort),
      "--control", String(slot.controlPort),
      "--read_time_ms", "1000",
      "--power", String(powerArg),
      ...antennaArgs,
      "--serial_host", host,
      "--serial_port", String(serialPort),
      "--fastid",
      // `--infinite` (matches Senitron's canonical readers.json command
      // for FIXED readers — `--infinite --power N`). Live evidence on
      // 2026-05-01 showed `--oscillating` produces one inventory burst
      // (~200 records) then the binary stays alive but stops emitting
      // any bytes for 30+ minutes — same alive-but-stuck behaviour we
      // were trying to avoid. With --infinite the binary streams
      // continuously, occasionally aborts after ~30-45s of saturation,
      // and the on-exit respawn (plus the re-enabled silence watchdog)
      // keeps reads flowing in normal warehouse usage. NEITHER --cstream
      // NOR --nocache are passed — both suppress live emission on the
      // --stream socket for this 2016 binary in our consumer setup
      // (Senitron's cdm reads them via the control protocol; we read
      // raw stream bytes, so we omit them).
      "--infinite",
    ];
    log.info("supervisor: spawning MonsoonReader", {
      readerId: spec.id,
      readerName: spec.name,
      antennas: enabledAntennas.map((a) => a.antenna_number),
      mode:
        enabledAntennas.length >= 2
          ? `mux:${enabledAntennas.map((a) => a.antenna_number).join(",")}`
          : enabledAntennas.length === 1
            ? `single:${enabledAntennas[0]!.antenna_number}`
            : "default:1",
      power: powerArg,
      serialPort,
    });

    const child = spawn(this.binaries.stream, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/opt/legacy-rfid/runtime",
    });
    slot.child = child;
    // Grace window for startup — without this the watchdog would kick a
    // freshly-spawned MonsoonReader before its stream socket has even
    // produced its first byte.
    slot.lastByteAt = Date.now();

    // We don't need MonsoonReader's stdout/stderr — drain to avoid back-pressure.
    child.stdout?.resume();
    child.stderr?.resume();

    child.on("exit", (code, signal) => {
      slot.child = null;
      slot.streamSocket?.destroy();
      slot.streamSocket = null;
      if (slot.shuttingDown) return;
      // MonsoonReader's design (matching the legacy Senitron `cdm`
      // orchestrator) is to run a fixed-cycles inventory and exit cleanly.
      // The legacy `readers.json` doesn't use any "infinite" flag — the
      // orchestrator just respawns on every exit. Treat code=0 as a healthy
      // completion (no backoff growth, immediate respawn). Non-zero exits or
      // signals are treated as faults — exponential backoff up to MAX.
      const cleanExit = code === 0 && !signal;
      const delay = cleanExit ? 250 : slot.backoffMs;
      if (cleanExit) {
        log.debug("supervisor: MonsoonReader cycle complete, respawning", {
          readerId: spec.id,
        });
      } else {
        log.warn("supervisor: MonsoonReader exited unexpectedly, will respawn", {
          readerId: spec.id,
          code,
          signal,
          backoffMs: slot.backoffMs,
        });
      }
      setTimeout(() => {
        void this.spawnReader(slot);
      }, delay);
      slot.backoffMs = cleanExit ? 1000 : Math.min(slot.backoffMs * 2, MAX_BACKOFF_MS);
    });

    // Connect to the MonsoonReader's stream port to receive tag-read bytes.
    // It takes a couple seconds for MonsoonReader to bind its listener +
    // initialize the radio, so wait before connecting.
    setTimeout(() => this.connectStream(slot), 2_500);
  }

  /**
   * Console-driver spawn: drives the 2024 `new_monsoonreader` binary which
   * outputs one tag-read per line on stdout, CRC-filtered at the source.
   * No TCP stream port, no stuck-state watchdog needed — this binary streams
   * continuously (verified ~1500 reads/sec sustained against .76 with no
   * silence stalls). Antenna number is stamped at spawn time since the binary
   * doesn't include it in console output.
   */
  private spawnReaderConsole(slot: ReaderSlot): void {
    if (slot.shuttingDown) return;
    const { spec, testSession } = slot;
    const host = String(spec.network_address ?? "");
    const port =
      slot.candidatePorts[slot.candidatePortIdx] ??
      slot.candidatePorts[0] ??
      Number(spec.monsoon_serial_port);

    // Resolve flags. TEST_MODE wins; otherwise normal scan defaults.
    let powerArg: number;
    let stampAntenna: number;
    let cycleMode: "infinite" | "oscillating";
    let readTimeMs: number;
    let tagFocus: boolean;
    if (testSession) {
      powerArg = testSession.powerArg;
      stampAntenna = testSession.antennaNumber;
      cycleMode = testSession.cycleMode;
      readTimeMs = testSession.readTimeMs;
      tagFocus = testSession.tagFocus;
    } else {
      powerArg = Math.round(this.avgPower(spec) * 10);
      const enabled = spec.antennas.filter((a) => a.enabled);
      const stampAnt = enabled[0];
      stampAntenna = stampAnt?.antenna_number ?? 1;
      // Per-antenna saved defaults from /antenna_test → "Save as default";
      // fall back to hardcoded normal-scan defaults when none set.
      const beh = stampAnt?.behaviour;
      cycleMode = beh?.cycle_mode === "oscillating" ? "oscillating" : "infinite";
      // 200ms inventory cycle (was 1000ms). The reader emits one burst of
      // EPC lines per cycle; tighter cycles = smoother stdout cadence,
      // which the read-aggregator then forwards via the 250ms flush. Net
      // effect is the live-scan counter moves in ~5 small steps/sec
      // instead of 1 big jump/sec. Below ~100ms protocol overhead starts
      // eating into throughput; 200ms is the sweet spot.
      readTimeMs = beh?.read_time_ms ?? 200;
      tagFocus = beh?.tag_focus === true;
    }
    slot.consoleStampAntenna = stampAntenna;

    const antennaArgs: string[] = [];
    if (stampAntenna !== 1) antennaArgs.push("-a", String(stampAntenna));

    const cycleArg = cycleMode === "oscillating" ? "--oscillating" : "--infinite";

    // CLI: `new_monsoonreader <host> <port> --console (--infinite|--oscillating)
    //       --power N --read_time MS [-a N] [--tagfocus]`
    const args: string[] = [
      host,
      String(port),
      "--console",
      cycleArg,
      "--power", String(powerArg),
      "--read_time", String(readTimeMs),
      ...antennaArgs,
    ];
    if (tagFocus) args.push("--tagfocus");

    log.info("supervisor: spawning new_monsoonreader (console driver)", {
      readerId: spec.id,
      readerName: spec.name,
      mode: testSession ? "TEST_MODE" : "normal",
      sessionId: testSession?.sessionId,
      host,
      port,
      power: powerArg,
      stampAntenna,
      cycleMode,
      readTimeMs,
      tagFocus,
    });

    slot.consoleParserState = newConsoleParserState();
    slot.bytesSinceSpawn = false;
    slot.lastByteAt = Date.now();

    const child = spawn(this.binaries.console, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/opt/legacy-rfid/runtime",
    });
    slot.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      log.debug("supervisor: console reader stderr", {
        readerId: spec.id,
        msg: chunk.toString().slice(0, 200),
      });
    });

    let totalRecords = 0;
    let totalBad = 0;
    let totalMal = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.length === 0) return;
      slot.lastByteAt = Date.now();
      if (!slot.bytesSinceSpawn) slot.bytesSinceSpawn = true;
      slot.consecutiveZeroByteKicks = 0;

      const result = parseConsoleChunk(chunk.toString("utf8"), slot.consoleParserState);
      totalRecords += result.records.length;
      totalBad += result.badCrcCount;
      totalMal += result.malformedCount;
      if (result.records.length > 0) slot.lastRecordAt = Date.now();

      const stamp = new Date().toISOString();
      const ts = slot.testSession;
      for (const rec of result.records) {
        // Antenna-test windows: every record from this child belongs to
        // `consoleStampAntenna`; if a window is open for that antenna,
        // count it.
        if (slot.activeTests.size > 0) {
          for (const win of slot.activeTests.values()) {
            if (win.antennaNumber === slot.consoleStampAntenna) {
              win.epcCount += 1;
            }
          }
        }
        if (ts && this.onTestModeRead) {
          // TEST_MODE: route to the controller's own ingest path; do NOT
          // mix into normal reads (different ingest endpoint, no DB write).
          this.onTestModeRead(ts.sessionId, {
            epcHex: rec.epcHex,
            rssiDbm: rec.rssiDbm,
            antennaNumber: slot.consoleStampAntenna,
            observedAt: stamp,
            powerArg: ts.powerArg,
          });
        } else {
          this.onRead({
            readerId: spec.id,
            epcHex: rec.epcHex,
            antennaNumber: slot.consoleStampAntenna,
            rssi: rec.rssiDbm,
            readAt: stamp,
          });
        }
      }
    });

    child.on("exit", (code, signal) => {
      slot.child = null;
      if (slot.shuttingDown) return;
      const cleanExit = code === 0 && !signal;
      const delay = cleanExit ? 250 : slot.backoffMs;
      log.info("supervisor: new_monsoonreader exited", {
        readerId: spec.id,
        code,
        signal,
        totalRecords,
        droppedBadCrc: totalBad,
        malformed: totalMal,
        cleanExit,
      });
      setTimeout(() => {
        void this.spawnReader(slot);
      }, delay);
      slot.backoffMs = cleanExit ? 1000 : Math.min(slot.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }

  private connectStream(slot: ReaderSlot): void {
    if (slot.shuttingDown || slot.child === null) return;
    // Each reconnect is a fresh stream from MonsoonReader's perspective —
    // it sends the 5-byte file header again, so reset parser state.
    slot.parserState = newParserState();
    slot.buffer = Buffer.alloc(0);
    const sock = net.createConnection(slot.streamPort, "127.0.0.1");
    slot.streamSocket = sock;
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) {
        log.warn("supervisor: stream connect timeout, killing reader", {
          readerId: slot.spec.id,
          port: slot.streamPort,
        });
        sock.destroy();
        slot.child?.kill("SIGKILL");
      }
    }, 8_000);

    sock.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      slot.backoffMs = MIN_BACKOFF_MS; // reset backoff on a successful connect
      log.info("supervisor: stream connected", {
        readerId: slot.spec.id,
        port: slot.streamPort,
      });
    });

    sock.on("data", (chunk: Buffer) => this.consumeStreamBytes(slot, chunk));

    sock.on("error", (err) => {
      log.warn("supervisor: stream socket error", {
        readerId: slot.spec.id,
        err: err.message,
      });
    });

    sock.on("close", () => {
      if (slot.streamSocket === sock) slot.streamSocket = null;
    });
  }

  /**
   * Consume bytes from the MonsoonReader stream and forward every
   * complete tag-read record. Parsing is delegated to stream-parser.ts
   * which understands the 50-byte fixed-length record layout.
   */
  private consumeStreamBytes(slot: ReaderSlot, chunk: Buffer): void {
    if (chunk.length > 0) {
      slot.lastByteAt = Date.now();
      // First-byte signal: tells the watchdog this candidate port is the
      // right one and on hang we should respawn (not rotate). Also resets
      // the unreachable-counter so a reader that recovers gets full
      // rotation budget back next time it goes silent.
      if (!slot.bytesSinceSpawn) slot.bytesSinceSpawn = true;
      slot.consecutiveZeroByteKicks = 0;
    }
    // Append to slot buffer; cap growth to avoid unbounded memory.
    slot.buffer = Buffer.concat([slot.buffer, chunk]);
    if (slot.buffer.length > 1024 * 1024) {
      // Keep only the tail; protocol records are 50B, so 64K covers a huge
      // multi-record gap if we ever fall behind on read.
      slot.buffer = slot.buffer.subarray(slot.buffer.length - 65_536);
    }

    const result = parseStream(slot.buffer, slot.parserState);
    slot.buffer = result.remaining;
    if (result.skipped > 0) {
      log.debug("supervisor: parser skipped bytes during resync", {
        readerId: slot.spec.id,
        skipped: result.skipped,
      });
    }

    const now = Date.now();
    if (result.records.length > 0) slot.lastRecordAt = now;
    for (const rec of result.records) {
      // Per-antenna test windows: count every record whose antenna_number
      // matches an active window for THIS reader.
      if (slot.activeTests.size > 0) {
        for (const win of slot.activeTests.values()) {
          if (win.antennaNumber === rec.antennaNumber) {
            win.epcCount += 1;
          }
        }
      }

      // Soft per-(epc, antenna) dedupe to absorb burst repeats.
      const dedupKey = `${rec.epcHex}@${rec.antennaNumber}`;
      const last = slot.lastSeen.get(dedupKey);
      if (last !== undefined && now - last < DEDUP_WINDOW_MS) continue;
      slot.lastSeen.set(dedupKey, now);

      // Always use receive-time as `readAt`. The reader's on-wire timestamp
      // can be many minutes off (the SA-2000's clock and the radio's
      // internal sequencing don't track wall-clock reliably), and the user-
      // facing dashboard cares about "when did the agent see this", not
      // about the radio's internal epoch.
      this.onRead({
        readerId: slot.spec.id,
        epcHex: rec.epcHex,
        antennaNumber: rec.antennaNumber,
        rssi: rec.rssiDbm,
        readAt: new Date(now).toISOString(),
      });
    }

    // Periodically prune lastSeen to stop unbounded growth.
    if (slot.lastSeen.size > 5_000) {
      const cutoff = now - DEDUP_WINDOW_MS * 5;
      for (const [k, t] of slot.lastSeen) {
        if (t < cutoff) slot.lastSeen.delete(k);
      }
    }
  }

  /**
   * Stop the binary AND ensure the SA-2000's R2000 chip stops transmitting.
   *
   * Critical detail: when MonsoonReader / new_monsoonreader is mid-cycle
   * and we SIGTERM it, the binary needs time to issue
   * `RFID_RadioAbortOperation` to the chip before it exits — otherwise
   * the radio keeps running its `--infinite` cycle independently and the
   * chassis stays hot, even though no agent is connected. The 3 s grace
   * we used to give was not always enough; live evidence 2026-05-04 showed
   * all three readers' radios still cycling after a pause-all click. We
   * caught it because an operator touched a chassis and reported it hot.
   *
   * Mitigation: extend the grace to 10 s. The console binary's abort
   * sequence ("Cancelling read... Cancel confirmed") finishes within
   * 1-2 s in practice; 10 s is safe headroom even if a cycle was just
   * starting when SIGTERM arrived. Worst case (binary genuinely hung):
   * SIGKILL still fires at 10 s, same as before.
   *
   * The streamSocket close is intentionally first — it forces the binary
   * out of any blocking write-to-stream syscall so its main loop can
   * notice the SIGTERM and run cleanup.
   */
  private stopSlot(slot: ReaderSlot): void {
    slot.shuttingDown = true;
    slot.streamSocket?.destroy();
    slot.streamSocket = null;
    if (slot.child) {
      slot.child.kill("SIGTERM");
      setTimeout(() => slot.child?.kill("SIGKILL"), 10_000);
      // Belt-and-braces: after the child exits, spawn a brief abort cycle
      // to GUARANTEE the radio is stopped. The legacy stream binary's
      // startup sequence ALWAYS issues RFID_RadioAbortOperation before
      // any other radio command — so spawning + immediately stopping it
      // is a deterministic way to push a stop into the R2000 chip even
      // if the prior child was SIGKILL'd mid-cycle. Without this, an
      // operator click on Pause leaves the chassis transmitting RF
      // ("infinite cycle" command in the chip's queue) and physically
      // hot, which is exactly the bug 2026-05-04 caught with .79.
      setTimeout(() => this.ensureRadioStopped(slot.spec), 11_000);
    }
  }

  /**
   * Spawn the legacy MonsoonReader briefly against the given reader, give
   * it 4 s for its startup abort sequence to land, then kill cleanly.
   * The binary's first action on connect is RFID_RadioAbortOperation —
   * which is exactly what we want. Tolerant of failure (segfault on the
   * binary itself, network unreach, etc.) — radio stays at whatever
   * state it was in before, which is the same as before this call.
   */
  private ensureRadioStopped(spec: AgentConfigReader): void {
    const host = String(spec.network_address ?? "");
    if (!host) return;
    const port = Number(spec.monsoon_serial_port ?? 10002);
    const args = [
      "--num", "1",
      "--stream", "39999",   // ephemeral, never connected
      "--control", "29999",
      "--read_time_ms", "1000",
      "--power", "100",       // low — we don't actually want a long cycle
      "--serial_host", host,
      "--serial_port", String(port),
      "--fastid",
      "--infinite",
    ];
    let child: ChildProcess | null = null;
    try {
      child = spawn(this.binaries.stream, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: "/opt/legacy-rfid/runtime",
      });
      child.stdout?.resume();
      child.stderr?.resume();
      child.on("error", (e) => {
        log.debug("ensureRadioStopped: spawn error (radio may already be off)", {
          host,
          err: e.message,
        });
      });
      // 4 s gives the binary time to connect + issue the startup abort.
      // After that we SIGTERM cleanly so it sends another abort on shutdown.
      setTimeout(() => {
        try { child?.kill("SIGTERM"); } catch { /* */ }
        setTimeout(() => {
          try { child?.kill("SIGKILL"); } catch { /* */ }
        }, 3_000);
      }, 4_000);
      log.info("ensureRadioStopped: forced radio abort sent", {
        readerId: spec.id,
        host,
      });
    } catch (e) {
      log.warn("ensureRadioStopped: failed to spawn abort binary", {
        host,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
