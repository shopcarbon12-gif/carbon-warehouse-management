/**
 * Direct-binary raw reader test: WMS spawns `new_monsoonreader --console`
 * itself, parses stdout, fans out reads via SSE. No DB lookup, no agent
 * involvement, no supervisor rules. The operator must pause the reader in
 * production FIRST so the WIZnet bridge is free (single-client constraint).
 *
 * Lifecycle:
 *   - POST /api/admin/reader-raw-test/direct/start → spawnDirectSession()
 *     spawns the binary, returns a sessionId.
 *   - Browser opens GET /direct/stream?sessionId=… → subscribes via the
 *     same antenna-test-hub for read fan-out.
 *   - POST /direct/stop → stopDirectSession() SIGTERMs (then SIGKILLs)
 *     the child and clears the session.
 *   - Idle prune: SSE pings every 25 s touch the session; if no ping
 *     arrives for 60 s the session is auto-killed (covers tab close).
 *
 * Safety:
 *   - One concurrent session per dev WMS process. The bridge is the real
 *     bottleneck (single-client) and we can't see other sessions on other
 *     hosts, so this is best-effort.
 *   - Power hard-clamped to 0..330 (0..33 dBm).
 *   - IP restricted to RFC-1918 private ranges to prevent the binary from
 *     being aimed at arbitrary internet hosts.
 *   - Spawn uses an explicit argv array (no shell), so values are never
 *     interpolated into a string. spawnTeenSafe.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
// Inlined from apps/carbon-cdm/src/console-parser.ts (which is ESM "type":"module"
// and trips Next.js' production build TypeScript check when imported into the
// WMS bundle). Kept tight — only the 30-line parser the dev tool actually uses.
// Format produced by `new_monsoonreader --console`:
//   RSSI -68.40 PC 3400 EPC F0A0B30E4F9B8C90000026B3 CRC 4CD0 (calculated 4CD0, OK)
const CONSOLE_LINE_RE =
  /^RSSI (-?\d+(?:\.\d+)?) PC ([0-9A-Fa-f]+) EPC ([0-9A-Fa-f]+) CRC ([0-9A-Fa-f]+) \(calculated ([0-9A-Fa-f]+), (OK|WRONG!)\)$/;

type ConsoleParserState = { buf: string };
type ConsoleParsedRead = { epcHex: string; rssiDbm: number; pc: string; crcOk: boolean };
type ConsoleParseResult = {
  records: ConsoleParsedRead[];
  badCrcCount: number;
  malformedCount: number;
};

function newConsoleParserState(): ConsoleParserState {
  return { buf: "" };
}

function parseConsoleChunk(input: string, state: ConsoleParserState): ConsoleParseResult {
  const combined = state.buf + input;
  const lines = combined.split("\n");
  state.buf = lines.pop() ?? "";
  const records: ConsoleParsedRead[] = [];
  let badCrcCount = 0;
  let malformedCount = 0;
  for (const raw of lines) {
    if (raw.length === 0) continue;
    const m = CONSOLE_LINE_RE.exec(raw.trim());
    if (!m) {
      malformedCount += 1;
      continue;
    }
    const rssi = Number.parseFloat(m[1]!);
    if (!Number.isFinite(rssi)) {
      malformedCount += 1;
      continue;
    }
    const crcOk = m[6] === "OK";
    if (!crcOk) {
      badCrcCount += 1;
      continue;
    }
    records.push({
      rssiDbm: rssi,
      pc: m[2]!.toUpperCase(),
      epcHex: m[3]!.toUpperCase(),
      crcOk,
    });
  }
  return { records, badCrcCount, malformedCount };
}
import {
  publishAntennaTestRead,
  publishAntennaTestLifecycle,
  publishAntennaTestStats,
} from "@/lib/server/antenna-test-hub";

export type DirectSessionInput = {
  tenantId: string;
  startedBy: string | null;
  bridgeIp: string;
  bridgePort: number;
  antennaNumber: number;
  powerArg: number;
  readTimeMs: number;
};

/**
 * If no parseable read arrives in this window after spawn, we assume the
 * bridge is held by another client (production agent) and auto-stop the
 * binary so it doesn't camp on the bridge slot indefinitely. Operator
 * still sees the "ended" lifecycle event with the silent-timeout reason.
 */
const SILENCE_TIMEOUT_MS = 15_000;

export type DirectSession = {
  id: string;
  tenantId: string;
  startedBy: string | null;
  bridgeIp: string;
  bridgePort: number;
  antennaNumber: number;
  powerArg: number;
  readTimeMs: number;
  startedAt: number;
  lastSeenAt: number;
  totalReads: number;
  uniqueEpcs: Set<string>;
  droppedBadCrc: number;
  child: ChildProcess | null;
  parserState: ConsoleParserState;
  statsTimer: NodeJS.Timeout | null;
  silenceTimer: NodeJS.Timeout | null;
  /** Set when the binary exits OR the operator stops. Kept in the Map for
   *  the SESSION_MAX_IDLE_MS grace window so a slow-to-subscribe SSE can
   *  still pick up the final lifecycle reason — invaluable when the bridge
   *  is held by production and the binary dies in < 1 s. */
  endedAt: number | null;
  /** Human-readable final reason. Mirrors the lifecycle event payload so a
   *  late SSE subscriber can be told what happened. */
  endReason: string | null;
};

const SESSION_MAX_IDLE_MS = 60_000;

const binaryPath = (): string =>
  process.env.CARBON_RAW_TEST_BINARY?.trim() ||
  "/home/carbondev/legacy-rfid-bundle/new_monsoonreader";

/**
 * The 2019 legacy MonsoonReader binary. We spawn this briefly BEFORE the
 * inventory binary on every Start to send the chip's `RFID_RadioAbortOperation`
 * + re-init sequence. Without this prelude, a chip left in a post-Stop
 * wedge state by the production supervisor won't respond to a fresh
 * `new_monsoonreader --console` connect — symptom: TCP succeeds, zero
 * reads at every power level. Matches the prod supervisor's pattern at
 * apps/carbon-cdm/src/monsoon-supervisor.ts:1830 (ensureRadioStopped).
 */
const legacyBinaryPath = (): string =>
  process.env.CARBON_RAW_TEST_LEGACY_BINARY?.trim() ||
  "/home/carbondev/legacy-rfid-bundle/MonsoonReader";

/** How long to let the legacy binary run its startup-abort + a short
 *  inventory cycle to clear stale Gen2 / TagFocus state on the chip,
 *  before we kill it and hand the bridge to new_monsoonreader. Prod's
 *  ensureRadioStopped uses 4 s; mirror that — anything shorter risks
 *  the startup abort sequence not finishing before we SIGKILL the
 *  process and the chip ends up in a partially-aborted state. */
const WAKE_PRELUDE_MS = 4_000;

/** Bridge TCP-slot release window. WIZnet's bridge holds the TCP slot
 *  for ~1 s after the client process dies before accepting the next
 *  connection. Without this gap, new_monsoonreader's connect either
 *  fails or sees stale UART data and silently exits code 0. */
const BRIDGE_SETTLE_MS = 1_200;

/**
 * Pinned to globalThis so that webpack/Next.js dev-mode double-evaluation
 * of this module (which happens because /start, /stop, /stream live in
 * separate route bundles) doesn't give us a fresh empty Map per bundle.
 * Without this, /start adds a session into bundle-A's Map, /stream looks
 * it up in bundle-B's Map and 404s. Symptom: binary running but SSE
 * returns 404 immediately after start.
 */
const G = globalThis as unknown as {
  __rawTestDirectById?: Map<string, DirectSession>;
};
const byId: Map<string, DirectSession> =
  G.__rawTestDirectById ?? (G.__rawTestDirectById = new Map());

function pruneStale(now: number): void {
  for (const s of Array.from(byId.values())) {
    if (s.endedAt !== null) {
      // Already ended; just GC the row after the idle window so a slow
      // SSE has time to subscribe and read endReason.
      if (now - s.endedAt > SESSION_MAX_IDLE_MS) byId.delete(s.id);
    } else if (now - s.lastSeenAt > SESSION_MAX_IDLE_MS) {
      stopDirectSession(s.id, "idle_timeout");
    }
  }
}

function markEnded(s: DirectSession, reason: string): void {
  if (s.endedAt !== null) return;
  s.endedAt = Date.now();
  s.endReason = reason;
  if (s.statsTimer) {
    clearInterval(s.statsTimer);
    s.statsTimer = null;
  }
  if (s.silenceTimer) {
    clearTimeout(s.silenceTimer);
    s.silenceTimer = null;
  }
  publishAntennaTestLifecycle(s.id, "ended", reason);
}

/** RFC-1918 + link-local. Anything else is rejected up front. */
export function isPrivateIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = [m[1], m[2], m[3], m[4]].map((x) => Number.parseInt(x!, 10));
  if (o.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local (some bridges fall here)
  return false;
}

export function spawnDirectSession(input: DirectSessionInput): {
  ok: true;
  session: DirectSession;
} | {
  ok: false;
  reason: "busy" | "bad_ip" | "spawn_failed";
  detail?: string;
} {
  pruneStale(Date.now());
  // "Busy" means an ACTIVE session, not a recently-ended one waiting on
  // its SSE grace window. Otherwise the operator can't immediately retry
  // after a failed connect.
  for (const s of byId.values()) {
    if (s.endedAt === null) return { ok: false, reason: "busy" };
  }
  if (!isPrivateIpv4(input.bridgeIp)) {
    return { ok: false, reason: "bad_ip" };
  }

  const now = Date.now();
  const session: DirectSession = {
    id: randomUUID(),
    tenantId: input.tenantId,
    startedBy: input.startedBy,
    bridgeIp: input.bridgeIp,
    bridgePort: input.bridgePort,
    antennaNumber: input.antennaNumber,
    powerArg: input.powerArg,
    readTimeMs: input.readTimeMs,
    startedAt: now,
    lastSeenAt: now,
    totalReads: 0,
    uniqueEpcs: new Set<string>(),
    droppedBadCrc: 0,
    child: null,
    parserState: newConsoleParserState(),
    statsTimer: null,
    silenceTimer: null,
    endedAt: null,
    endReason: null,
  };

  byId.set(session.id, session);

  // Stage 1 — chip wake prelude. Spawn the 2019 legacy MonsoonReader for
  // a short window. Its startup sends RFID_RadioAbortOperation (clears any
  // stuck Gen2 select/TagFocus state from a prior Stop) and then runs
  // inventory briefly. On SIGTERM it sends another abort cleanly. After
  // this, the chip is in the "freshly-aborted, ready for inventory" state
  // the new console binary expects.
  publishAntennaTestLifecycle(session.id, "armed", "wake_prelude — sending chip-init via legacy binary");
  const preludeStreamPort = 39000 + Math.floor(Math.random() * 1000);
  const preludeControlPort = 29000 + Math.floor(Math.random() * 1000);
  const preludeArgs = [
    "--num", "1",
    "--stream", String(preludeStreamPort),
    "--control", String(preludeControlPort),
    "--read_time_ms", "500",
    "--power", "100",
    "--serial_host", input.bridgeIp,
    "--serial_port", String(input.bridgePort),
    "--fastid",
    "--infinite",
  ];
  let prelude: ChildProcess | null = null;
  try {
    prelude = spawn(legacyBinaryPath(), preludeArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    prelude.stdout?.resume();
    prelude.stderr?.resume();
    prelude.on("error", () => { /* binary may not exist — tolerate */ });
  } catch {
    /* tolerate: we'll fall through to the inventory binary anyway */
  }

  // Chain inventory exactly once, on prelude exit OR by failsafe.
  // The legacy binary issues `RFID_RadioAbortOperation` to the chip
  // within ~200 ms of connect — the only purpose of letting it run
  // 1.5 s is to give the chip's PLL/RF stage time to re-arm. We then
  // SIGKILL the prelude (no graceful cleanup needed — the startup
  // abort already landed) so the bridge's TCP slot frees fast.
  let inventoryChained = false;
  const chainInventory = (): void => {
    if (inventoryChained) return;
    inventoryChained = true;
    setTimeout(() => spawnInventoryBinary(session, input), BRIDGE_SETTLE_MS);
  };
  if (prelude) {
    prelude.on("exit", chainInventory);
    prelude.on("close", chainInventory);
  } else {
    setTimeout(chainInventory, 200);
  }
  setTimeout(() => {
    if (prelude && prelude.exitCode === null) {
      try {
        if (prelude.pid) process.kill(-prelude.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
  }, WAKE_PRELUDE_MS);

  return { ok: true, session };
}

/**
 * Stage 2 of the two-stage spawn: the actual inventory binary that the
 * operator's test cares about. Reached via setTimeout after the legacy
 * wake-prelude has aborted+re-initialised the chip.
 */
function spawnInventoryBinary(
  session: DirectSession,
  input: DirectSessionInput,
): void {
  // If the operator already hit Stop during the prelude, abandon.
  if (session.endedAt !== null) return;

  const args: string[] = [
    input.bridgeIp,
    String(input.bridgePort),
    "--console",
    "--infinite",
    "--power", String(input.powerArg),
    "--read_time", String(input.readTimeMs),
  ];
  if (input.antennaNumber !== 1) args.push("-a", String(input.antennaNumber));

  let child: ChildProcess;
  try {
    child = spawn(binaryPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    markEnded(
      session,
      `spawn_failed ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  session.child = child;
  publishAntennaTestLifecycle(session.id, "armed", "inventory_binary_spawned");

  child.stdout?.on("data", (chunk: Buffer) => {
    const result = parseConsoleChunk(chunk.toString("utf8"), session.parserState);
    if (result.badCrcCount > 0) session.droppedBadCrc += result.badCrcCount;
    for (const r of result.records) {
      session.totalReads += 1;
      session.uniqueEpcs.add(r.epcHex);
      publishAntennaTestRead(session.id, {
        epcHex: r.epcHex,
        rssiDbm: r.rssiDbm,
        antennaNumber: session.antennaNumber,
        observedAt: new Date().toISOString(),
      });
    }
    if (result.records.length > 0 && session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
    session.lastSeenAt = Date.now();
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString("utf8").trim();
    if (!msg) return;
    // Don't publish stderr lifecycle events once the session has ended.
    // The binary's shutdown handshake (`Cancelling read... Cancel confirmed`)
    // arrives ~100 ms AFTER the SIGTERM we sent — without this gate it
    // overwrites the real ended-reason (silent_timeout / stop) in the
    // operator's UI and looks like the failure was something else.
    if (session.endedAt !== null) return;
    publishAntennaTestLifecycle(session.id, "armed", msg.slice(0, 240));
  });

  child.on("exit", (code, signal) => {
    const tail =
      session.totalReads === 0 && (code === 0 || code === null)
        ? " — chip received init but produced no reads. Likely a different bug: try lower power, switch antenna, or check if the chip itself is wedged at chassis level."
        : "";
    markEnded(
      session,
      `binary_exit code=${code ?? "null"} signal=${signal ?? "null"}${tail}`,
    );
  });

  child.on("error", (err) => {
    markEnded(session, `spawn_error ${err.message}`);
  });

  session.statsTimer = setInterval(() => {
    publishAntennaTestStats(session.id, {
      uniqueEpcs: session.uniqueEpcs.size,
      totalReads: session.totalReads,
      droppedBadCrc: session.droppedBadCrc,
    });
  }, 500);

  session.silenceTimer = setTimeout(() => {
    if (session.totalReads === 0 && session.endedAt === null) {
      stopDirectSession(
        session.id,
        "silent_timeout — chip received the legacy abort+init prelude but new_monsoonreader still got zero reads in 15 s. This indicates a deeper chip wedge that the two-stage wake didn't recover. Try lower power, a different antenna number, or a different reader.",
      );
    }
  }, SILENCE_TIMEOUT_MS);
}

export function getDirectSession(id: string): DirectSession | null {
  pruneStale(Date.now());
  return byId.get(id) ?? null;
}

export function touchDirectSession(id: string): boolean {
  const s = byId.get(id);
  if (!s) return false;
  s.lastSeenAt = Date.now();
  return true;
}

export function stopDirectSession(id: string, reason: string): boolean {
  const s = byId.get(id);
  if (!s) return false;
  if (s.child && s.child.exitCode === null) {
    // Negative PID = kill the whole process group (detached:true above).
    try {
      if (s.child.pid) process.kill(-s.child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        if (s.child?.pid && s.child.exitCode === null) {
          process.kill(-s.child.pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
    }, 2_000);
  }
  // Don't delete from byId here — markEnded keeps the row for the SSE
  // grace window. pruneStale() collects it after SESSION_MAX_IDLE_MS.
  markEnded(s, reason);
  return true;
}
