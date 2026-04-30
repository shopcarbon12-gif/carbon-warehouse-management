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
};

export class MonsoonSupervisor {
  private slots = new Map<string, ReaderSlot>();
  private epcPrefixBytes: Buffer;
  private epcByteLen = 12;
  private bundleVersion = 0;

  constructor(
    private readonly monsoonBinary: string,
    private readonly onRead: SupervisorReadHandler,
    /** Hex string for EPC prefix to match on the binary stream (e.g. "F0A0"). */
    epcPrefixHex: string = "F0A0",
  ) {
    this.epcPrefixBytes = Buffer.from(epcPrefixHex, "hex");
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
  }

  shutdown(): void {
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
    const args = [
      "--num", "1",
      "--cstream",
      "--stream", String(slot.streamPort),
      "--control", String(slot.controlPort),
      "--read_time_ms", "1000",
      "--power", String(powerArg),
      "--serial_host", String(spec.network_address ?? ""),
      "--serial_port", String(spec.monsoon_serial_port),
      "--fastid",
      "--nocache",
      "--infinite",   // continuous inventory cycles, no client needed to drive it
    ];

    const child = spawn(this.monsoonBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/opt/legacy-rfid",
    });
    slot.child = child;

    // We don't need MonsoonReader's stdout/stderr — drain to avoid back-pressure.
    child.stdout?.resume();
    child.stderr?.resume();

    child.on("exit", (code, signal) => {
      slot.child = null;
      slot.streamSocket?.destroy();
      slot.streamSocket = null;
      if (slot.shuttingDown) return;
      log.warn("supervisor: MonsoonReader exited, will respawn", {
        readerId: spec.id,
        code,
        signal,
        backoffMs: slot.backoffMs,
      });
      setTimeout(() => this.spawnReader(slot), slot.backoffMs);
      slot.backoffMs = Math.min(slot.backoffMs * 2, MAX_BACKOFF_MS);
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
