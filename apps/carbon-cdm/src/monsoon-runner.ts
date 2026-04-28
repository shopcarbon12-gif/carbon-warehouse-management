import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import type { AgentEnv } from "./config.js";
import type { AgentConfigReader } from "./wms-client.js";
import { log } from "./log.js";
import { parseStream, type ParsedTagRead } from "./stream-parser.js";

export type ReadEvent = {
  readerId: string;
  reads: ParsedTagRead[];
  receivedAt: Date;
};

type RunnerCallbacks = {
  onReads: (ev: ReadEvent) => void;
};

/**
 * Owns one MonsoonReader subprocess + its stream socket. Spawns the binary,
 * waits for it to bind its --stream port, connects, parses the binary stream,
 * and emits parsed records to the supervisor.
 *
 * Resilience:
 *   - Re-connects to the stream port on socket errors (up to ~30 times).
 *   - If MonsoonReader itself exits, this runner does NOT auto-respawn — the
 *     supervisor's reconcile loop owns lifecycle decisions.
 */
export class MonsoonRunner {
  private child?: ChildProcess;
  private socket?: Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stopping = false;
  private connectAttempts = 0;
  private childExited = false;

  constructor(
    private readonly env: AgentEnv,
    public readonly spec: AgentConfigReader,
    private readonly callbacks: RunnerCallbacks,
  ) {}

  start(): void {
    const args = buildArgs(this.spec);
    log.info("spawning MonsoonReader", {
      reader_id: this.spec.id,
      reader_name: this.spec.name,
      stream_port: this.spec.stream_port,
      ip: this.spec.network_address,
      power_args: powerArgsForLog(this.spec),
      binary: this.env.CARBON_MONSOON_BINARY,
    });

    this.child = spawn(this.env.CARBON_MONSOON_BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (b: Buffer) => {
      log.debug("monsoon stdout", { reader_id: this.spec.id, line: b.toString().trim() });
    });
    this.child.stderr?.on("data", (b: Buffer) => {
      log.debug("monsoon stderr", { reader_id: this.spec.id, line: b.toString().trim() });
    });
    this.child.on("error", (e) => {
      log.error("monsoon spawn error", {
        reader_id: this.spec.id,
        err: e instanceof Error ? e.message : String(e),
      });
    });
    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      if (this.stopping) return;
      log.warn("MonsoonReader exited", {
        reader_id: this.spec.id,
        code,
        signal,
      });
      this.socket?.destroy();
    });

    // Give the subprocess a moment to bind its --stream port, then connect.
    setTimeout(() => this.connectStream(), 800);
  }

  private connectStream(): void {
    if (this.stopping || this.childExited) return;

    this.connectAttempts++;
    const sock = new Socket();
    this.socket = sock;

    sock.connect(this.spec.stream_port, "127.0.0.1", () => {
      log.info("connected to MonsoonReader stream", {
        reader_id: this.spec.id,
        port: this.spec.stream_port,
      });
      this.connectAttempts = 0;
    });

    sock.on("data", (chunk: Buffer) => this.onData(chunk));

    sock.on("error", (e) => {
      log.warn("stream socket error", {
        reader_id: this.spec.id,
        attempt: this.connectAttempts,
        err: e instanceof Error ? e.message : String(e),
      });
    });

    sock.on("close", () => {
      if (this.stopping || this.childExited) return;
      // Backoff and retry up to ~30 attempts (≈ 1 minute total).
      if (this.connectAttempts < 30) {
        const delayMs = Math.min(2000, 200 * this.connectAttempts);
        setTimeout(() => this.connectStream(), delayMs);
      } else {
        log.error("giving up on stream socket", { reader_id: this.spec.id });
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { records, remaining, skipped } = parseStream(this.buffer);
    this.buffer = remaining;
    if (skipped > 0) {
      log.debug("re-synced parser", { reader_id: this.spec.id, skipped });
    }
    if (records.length > 0) {
      this.callbacks.onReads({
        readerId: this.spec.id,
        reads: records,
        receivedAt: new Date(),
      });
    }
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    log.info("stopping MonsoonReader", {
      reader_id: this.spec.id,
      reader_name: this.spec.name,
    });
    this.socket?.destroy();
    if (this.child && this.child.exitCode === null && !this.childExited) {
      this.child.kill("SIGTERM");
      // Hard-kill if it doesn't go in 5s.
      setTimeout(() => {
        if (this.child && !this.childExited) this.child.kill("SIGKILL");
      }, 5000).unref();
    }
  }

  cmdline(): string {
    return [this.env.CARBON_MONSOON_BINARY, ...buildArgs(this.spec)].join(" ");
  }
}

function powerArgsForLog(spec: AgentConfigReader): { avg_dbm: number } {
  const enabled = spec.antennas.filter((a) => a.enabled);
  const avg = enabled.length
    ? enabled.reduce((s, a) => s + a.transmit_power_dbm, 0) / enabled.length
    : 30;
  return { avg_dbm: Math.round(avg * 10) / 10 };
}

function buildArgs(spec: AgentConfigReader): string[] {
  // SA-2000 takes one --power per process. Per-antenna power is averaged for
  // now; true per-antenna control is a v0.3 enhancement (use --control port
  // to update at runtime, or spawn one runner per antenna).
  const enabled = spec.antennas.filter((a) => a.enabled);
  const avg = enabled.length
    ? enabled.reduce((s, a) => s + a.transmit_power_dbm, 0) / enabled.length
    : 30;
  const powerArg = Math.round(avg * 10);

  return [
    "--num",
    "1",
    "--cstream",
    "--stream",
    String(spec.stream_port),
    "--control",
    String(spec.control_port),
    "--read_time_ms",
    "1000",
    "--power",
    String(powerArg),
    "--serial_host",
    String(spec.network_address ?? ""),
    "--serial_port",
    String(spec.monsoon_serial_port),
    "--fastid",
    "--nocache",
  ];
}
