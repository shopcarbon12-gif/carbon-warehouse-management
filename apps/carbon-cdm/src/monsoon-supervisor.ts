import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { log } from "./log.js";
import type { AgentConfigBundle, AgentConfigReader } from "./wms-client.js";

/**
 * Drives the legacy MonsoonReader binary directly — bypasses Senitron's
 * `cdm` middleware entirely. Senitron's cdm is supposed to glue
 * MonsoonReader's binary stream to whatever endpoint we configure, but in
 * our deployment cdm and MonsoonReader can't agree on direction (both
 * think they're the server, neither connects to the other) and no reads
 * ever flow.
 *
 * The protocol on MonsoonReader's `--stream` port is undocumented but
 * empirical capture shows raw 12-byte EPCs are dropped in the binary
 * stream right at the bytes — anywhere we find the customer's prefix
 * (e.g. F0 A0 B0 ...), the next 12 bytes are a complete SGTIN-96 EPC.
 * We scan for the prefix, extract the EPC, deduplicate over a short
 * window, and hand the EPCs off to the caller (which forwards to WMS).
 *
 * One MonsoonReader subprocess per reader. We restart any process that
 * dies, but with a backoff so a misconfigured reader can't pin a CPU.
 */

const STREAM_PORT_BASE = 30100;   // MonsoonReader --stream port for reader 0; +N per extra reader
const CONTROL_PORT_BASE = 20100;  // MonsoonReader --control port; +N per extra reader
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
// Window in which a re-read of the same EPC is suppressed (prevents
// 100×/sec dupes from a single tag flooding the WMS). 1 second matches
// MonsoonReader's per-antenna dwell time so each cycle reports each
// tag once.
const DEDUP_WINDOW_MS = 1_000;

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
  lastSeen: Map<string, number>;  // epcHex → ms timestamp
  backoffMs: number;
  shuttingDown: boolean;
  /** ms timestamp of the most recent byte arrival on streamSocket. The
   *  watchdog uses this to detect a "stuck but alive" MonsoonReader — the
   *  binary occasionally enters a state where the process is up, the stream
   *  socket is connected, but no inventory bytes ever arrive. We force a
   *  respawn after STREAM_SILENCE_TIMEOUT_MS of zero traffic. */
  lastByteAt: number;
  /**
   * Active antenna-test windows for THIS reader. Each entry is
   * incremented every time we observe an EPC byte sequence on the stream.
   * When the test window expires, we emit the result. Multiple antennas
   * on the same reader can have concurrent windows — they all see the
   * same byte stream (we can't distinguish per-antenna in the binary
   * protocol yet), so they share the count.
   */
  activeTests: Map<string, { startedAt: number; epcCount: number; expiresAt: number }>;
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
  private epcPrefixBytes: Buffer;
  private epcByteLen = 12;
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
    /** Hex string for EPC prefix to match on the binary stream (e.g. "F0A0"). */
    epcPrefixHex: string = "F0A0",
  ) {
    this.epcPrefixBytes = Buffer.from(epcPrefixHex, "hex");
    if (this.onAntennaTestResult) {
      this.testSweepHandle = setInterval(
        () => this.sweepExpiredTests(),
        TEST_SWEEP_INTERVAL_MS,
      );
    }
    // Stream-silence watchdog: every WATCHDOG_INTERVAL_MS, look at every slot
    // and force-respawn any whose stream socket has been silent longer than
    // STREAM_SILENCE_TIMEOUT_MS. The MonsoonReader binary occasionally enters
    // a "alive but not streaming" state where the process is up, the socket
    // is open, but no inventory bytes flow. Killing the child triggers the
    // exit handler which respawns immediately.
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
      "--cstream",
      "--stream", String(slot.streamPort),
      "--control", String(slot.controlPort),
      "--read_time_ms", "1000",
      "--power", String(powerArg),
      ...antennaArgs,
      "--serial_host", String(spec.network_address ?? ""),
      "--serial_port", String(spec.monsoon_serial_port),
      "--fastid",
      "--nocache",
      // `--infinite` is what tells MonsoonReader to start an inventory loop
      // automatically. Without it the binary sits in command-processor mode
      // waiting for external commands on the control port and the stream
      // socket stays silent. Verified via verbose run: no `--infinite` →
      // process exits cleanly without ever calling do_single_inventory().
      "--infinite",
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
   * Consume bytes from the MonsoonReader stream. Search for the EPC
   * prefix; whenever we find it, extract the next 12 bytes as an EPC.
   *
   * The protocol is binary and not aligned to record boundaries, so we
   * just scan the byte stream looking for the prefix. EPCs that are
   * actually arbitrary record metadata (e.g. RSSI byte happens to be
   * 0xF0 followed by 0xA0) are theoretically possible but vanishingly
   * rare with a 16-bit prefix; we filter further by requiring 24 hex
   * chars and dedupe within a 1-second window.
   */
  private consumeStreamBytes(slot: ReaderSlot, chunk: Buffer): void {
    if (chunk.length > 0) {
      slot.lastByteAt = Date.now();
    }
    // Append to slot buffer; cap growth to avoid unbounded memory.
    slot.buffer = Buffer.concat([slot.buffer, chunk]);
    if (slot.buffer.length > 1024 * 1024) {
      // Keep only the tail; protocol records are << 1MB.
      slot.buffer = slot.buffer.subarray(slot.buffer.length - 65_536);
    }

    const now = Date.now();
    let pos = 0;
    while (pos <= slot.buffer.length - this.epcByteLen) {
      const idx = slot.buffer.indexOf(this.epcPrefixBytes, pos);
      if (idx < 0) break;
      if (idx + this.epcByteLen > slot.buffer.length) break;
      const epc = slot.buffer.subarray(idx, idx + this.epcByteLen);
      const epcHex = epc.toString("hex").toUpperCase();
      pos = idx + 1; // search for next occurrence (overlap allowed)

      // Active antenna tests: every EPC found counts toward the test
      // window, regardless of dedup or prefix. (We restrict by F0A0 only
      // because that's the prefix we scan for; in practice the test
      // semantics — "did the reader see ANY tag" — are met since any tag
      // any operator would test against will be a Carbon F0A0B tag.)
      if (slot.activeTests.size > 0) {
        for (const win of slot.activeTests.values()) {
          win.epcCount += 1;
        }
      }

      // Dedup within window.
      const last = slot.lastSeen.get(epcHex);
      if (last !== undefined && now - last < DEDUP_WINDOW_MS) continue;
      slot.lastSeen.set(epcHex, now);

      this.onRead({
        readerId: slot.spec.id,
        epcHex,
        readAt: new Date(now).toISOString(),
      });
    }

    // Trim consumed prefix; keep the tail in case a prefix straddles
    // the last byte boundary.
    if (pos > 0) {
      slot.buffer = slot.buffer.subarray(Math.max(0, pos - this.epcPrefixBytes.length));
    }

    // Periodically prune lastSeen to stop unbounded growth (every ~1k entries).
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
