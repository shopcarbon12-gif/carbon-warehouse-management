import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { log } from "./log.js";
import type { AgentConfigBundle, AgentConfigReader } from "./wms-client.js";
import {
  parseStream,
  newParserState,
  type ParserState,
} from "./stream-parser.js";

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
  /** ms timestamp of the most recent byte arrival on streamSocket. The
   *  watchdog uses this to detect a "stuck but alive" MonsoonReader — the
   *  binary occasionally enters a state where the process is up, the stream
   *  socket is connected, but no inventory bytes ever arrive. We force a
   *  respawn after STREAM_SILENCE_TIMEOUT_MS of zero traffic. */
  lastByteAt: number;
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
};

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
 */
const STREAM_SILENCE_TIMEOUT_MS = 45_000;
const WATCHDOG_INTERVAL_MS = 5_000;

export class MonsoonSupervisor {
  private slots = new Map<string, ReaderSlot>();
  private bundleVersion = 0;
  private testSweepHandle: NodeJS.Timeout | null = null;
  private streamWatchdogHandle: NodeJS.Timeout | null = null;
  /** Set of antenna IDs we've already started a test for (one-shot per pending). */
  private testedAntennas = new Set<string>();

  constructor(
    private readonly monsoonBinary: string,
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
    // Stream-silence watchdog DISABLED 2026-04-30 after switching to
    // `--oscillating` mode. With --infinite, the binary would routinely enter
    // an "alive but not streaming" stuck state and needed force-respawning.
    // With --oscillating it stays healthy indefinitely (matches Senitron's
    // production cdm orchestrator, which has no watchdog at all). The
    // watchdog at 45s threshold was firing as a false-positive on quiet
    // warehouse periods (no tags moving = no bytes from binary, but binary
    // is fine), causing avoidable kicks that destroyed tag-to-UI latency.
    // systemd's Restart=on-failure on the parent agent service is sufficient
    // safety. Method runStreamWatchdog() and constants left in place for
    // easy re-enable if a different binary mode ever needs them again.
    void this.runStreamWatchdog;
    void STREAM_SILENCE_TIMEOUT_MS;
    void WATCHDOG_INTERVAL_MS;
  }

  private runStreamWatchdog(): void {
    const now = Date.now();
    for (const slot of this.slots.values()) {
      if (slot.shuttingDown) continue;
      if (!slot.child) continue;
      const silentMs = now - slot.lastByteAt;
      if (silentMs >= STREAM_SILENCE_TIMEOUT_MS) {
        log.warn("supervisor: stream silent — kicking MonsoonReader", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          silentMs,
        });
        slot.lastByteAt = now;
        slot.child?.kill("SIGTERM");
        // exit handler respawns
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
    const desiredById = new Map(bundle.readers.map((r) => [r.id, r]));

    // Stop slots for readers no longer in the bundle.
    for (const [id, slot] of this.slots) {
      if (!desiredById.has(id)) {
        log.info("supervisor: reader removed, stopping", { readerId: id, name: slot.spec.name });
        this.stopSlot(slot);
        this.slots.delete(id);
      }
    }

    // Start (or update) slots for readers in the bundle.
    let nextIndex = this.slots.size;
    for (const spec of bundle.readers) {
      const isMonsoon = !((spec.model ?? "").toLowerCase().includes("zebra"));
      if (!isMonsoon) {
        // Zebra readers are handled by a different driver — out of scope
        // for this supervisor.
        continue;
      }
      const existing = this.slots.get(spec.id);
      if (existing) {
        // Update the stored spec so any later ops see fresh power/antennas/etc.
        existing.spec = spec;
        // If subprocess is dead, restart cycle will pick it up.
        continue;
      }
      const idx = nextIndex++;
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
      };
      this.slots.set(spec.id, slot);
      log.info("supervisor: starting reader", {
        readerId: spec.id,
        name: spec.name,
        ip: spec.network_address,
        streamPort: slot.streamPort,
        controlPort: slot.controlPort,
      });
      this.spawnReader(slot);
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
    const { spec } = slot;
    const powerArg = Math.round(this.avgPower(spec) * 10);
    // MonsoonReader's `--num` is the reader INDEX (default 1), and `-a` takes
    // a SINGLE antenna number — using two `-a` flags makes the binary thread-
    // resource-throw because last-wins semantics combine with `--num` as
    // count-of-readers. So one process per reader, antenna 1 only by default;
    // explicit antenna number only when the operator configured exactly one
    // and it isn't 1. Multi-antenna readers will be handled by spawning one
    // child process per antenna in a future change (each with its own
    // stream / control port pair).
    const enabledAntennas = spec.antennas.filter((a) => a.enabled);
    const antennaArgs: string[] = [];
    if (enabledAntennas.length === 1 && enabledAntennas[0]!.antenna_number !== 1) {
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
      "--serial_host", String(spec.network_address ?? ""),
      "--serial_port", String(spec.monsoon_serial_port),
      "--fastid",
      // NOTE: NEITHER `--cstream` NOR `--nocache` are passed. Both flags
      // independently suppress live emission on the --stream port for
      // this 2016 binary. Empirical results 2026-05-01 (per-flag bytes
      // captured over 20s against reader 192.168.1.76 with continuous
      // tag motion):
      //   --cstream + --nocache + --oscillating  →   0 bytes (cache flush only)
      //   --cstream + --cache 1 + --oscillating  →   0 bytes
      //   --nocache + --oscillating              →   0 bytes (this was the bug)
      //   --nocache + --infinite                 →  ~7K bytes (and then aborts)
      //   default cache + --oscillating          →  ~6.6K bytes (continuous)
      // Default cache (--cache 60) is set internally by the binary; the
      // stream emits records as they're seen, while the cache is what the
      // remote-Monsoon protocol uses for back-fill — irrelevant to us.
      // `--oscillating` (oscillating cycle inventory) — built-in pauses
      // between cycles keep the binary stable. `--infinite` saturates the
      // radio and the binary aborts after ~30-45 sec; on-exit respawn
      // handles those cases when they happen.
      "--oscillating",
    ];
    log.info("supervisor: spawning MonsoonReader", {
      readerId: spec.id,
      readerName: spec.name,
      antennas: enabledAntennas.map((a) => a.antenna_number),
      antennaScanned: antennaArgs.length > 0 ? Number(antennaArgs[1]) : 1,
      power: powerArg,
    });

    const child = spawn(this.monsoonBinary, args, {
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
      setTimeout(() => this.spawnReader(slot), delay);
      slot.backoffMs = cleanExit ? 1000 : Math.min(slot.backoffMs * 2, MAX_BACKOFF_MS);
    });

    // Connect to the MonsoonReader's stream port to receive tag-read bytes.
    // It takes a couple seconds for MonsoonReader to bind its listener +
    // initialize the radio, so wait before connecting.
    setTimeout(() => this.connectStream(slot), 2_500);
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

  private stopSlot(slot: ReaderSlot): void {
    slot.shuttingDown = true;
    slot.streamSocket?.destroy();
    slot.streamSocket = null;
    if (slot.child) {
      slot.child.kill("SIGTERM");
      // hard-kill if it doesn't exit promptly
      setTimeout(() => slot.child?.kill("SIGKILL"), 3_000);
    }
  }
}
