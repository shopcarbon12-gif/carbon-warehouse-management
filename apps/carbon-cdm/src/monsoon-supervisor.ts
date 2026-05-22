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
import { wipeBridgeToDhcp } from "./wiznet-discovery.js";

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
 * Auto-sweep recovery: when port rotation alone fails to recover a stuck
 * radio (the "chassis-power-cycle wall" pattern — clean TCP, zero bytes),
 * walk the transmit power across these steps. A power-level CHANGE forces
 * the chassis RF stage to reconfigure (PLL relock + calibration), which
 * incidentally clears firmware-level stuck inventory states. Verified
 * 2026-05-09 via manual Antenna-Test Sweep mode on .22 and .82 — both
 * recovered without a physical PoE cycle. See
 * project_sweep_mode_unsticks_radio_2026_05_09 in agent memory.
 *
 * Powers are the `--power` arg in tenths of a dBm: 100 = 10 dBm, 330 = 33 dBm.
 *
 * GRANULARITY 2026-05-12: was [330, 200, 100] — three coarse steps with
 * 10-dBm gaps between them. Live evidence on .15 today: chip reads
 * cleanly at 15 dBm (= 150) but is silent at 10 / 20 / 25 / 33 dBm.
 * The original 3-step sweep skipped right over the working power and
 * declared the chassis broken. Now 6 steps with 5-dBm granularity so
 * narrow-band chips are catchable. Still high→low so a healthy chip
 * starts at configured power and exits sweep immediately.
 *
 * Each step does a fresh spawn → PLL relock + chip-side calibration,
 * which is also useful for chips wedged in Gen2 select state.
 */
/**
 * Power sweep granularity. The walker starts at SWEEP_POWERS[0] (operator-
 * configured maximum equivalent) and steps DOWN on silence. The FIRST step
 * that produces bytes is the HIGHEST working power for this chassis — that's
 * what the auto-suggest stashes as `suggestedPowerDbm`.
 *
 * Tightened from 6 coarse steps (330,270,200,150,100,50) to 16 fine steps
 * at 2 dBm intervals so the suggestion is precise instead of "somewhere
 * below 33." Live evidence 2026-05-12: .15 found working at 150 (15 dBm)
 * with coarse steps — but we never tested 170/190/210, any of which might
 * have worked too. Finer granularity = better range for the operator.
 *
 * Worst-case walk time: 16 steps × MIN_SWEEP_DWELL_MS (10 s) = 160 s.
 * Acceptable for a recovery diagnostic that runs once and stops at first
 * working power.
 */
const SWEEP_POWERS: readonly number[] = [
  330, 310, 290, 270, 250, 230, 210, 190, 170, 150, 130, 110, 90, 70, 50, 30,
];
/**
 * Cooldown between full sweep-recovery attempts (after a sweep ran
 * through every power step and produced no bytes). 60 s — short enough
 * that a flaky chassis keeps getting retried autonomously without
 * operator intervention. Previously 30 minutes, which left dead-looking
 * readers idle for half-hour windows. Combined with auto-bridge-reset
 * on sweep failure (see runStreamWatchdog), the 60-s retry usually
 * succeeds because the bridge has been reset in between.
 */
const SWEEP_RETRY_COOLDOWN_MS = 10_000;
/**
 * When sweep recovery succeeds at a sub-configured power, pin the
 * slot to that power so it keeps producing reads. After this interval
 * we drop the pin and let the next spawn use the operator's configured
 * power again — if the chip has genuinely recovered we escalate back,
 * if it re-wedges sweep recovery just kicks in again and re-pins.
 * 3 min — short enough that a recovered chip returns to full power
 * fast (so we're not silently leaving readers at low power forever),
 * long enough that brief glitches don't trigger constant thrashing.
 * Was 30 min — observed live with .15: chip provably reads at 33 dBm
 * (594 reads in 21 s during antenna test) but slot remained pinned at
 * 10 dBm for 30 min after a stale sweep recovery — operator saw 9
 * unique EPCs while chip could've seen many more at full power.
 */
const SWEEP_OVERRIDE_RETEST_MS = 3 * 60 * 1000;

/**
 * Minimum time the sweep must dwell at the CURRENT power step before
 * advancing on a 0-byte exit. Without this, the binary exits in <1 s
 * with no bytes (the chip needs warm-up time), the supervisor reads
 * that as "silent at this power, try next", and sweep walks past a
 * working power before the chip even had a chance to produce a frame.
 * Observed live on .15 — chip produces 594 reads at 33 dBm in test
 * mode (multi-second), but sweep advanced past 33 → 27 → 20 → 15 in
 * the first ~5 s after recovery start because each cycle was a
 * sub-second silent exit.
 */
const MIN_SWEEP_DWELL_MS = 10_000;

/**
 * Quiet window after firing `wiznet-cli --reset`. The bridge takes ~8-12 s
 * to come back on the network; the chip behind the bridge needs another
 * 5-10 s for its UART to drain whatever half-open Gen2 state the prior
 * supervisor child left it in. If the next reader spawn races the reset
 * (today's default 5 s grace), it lands on a wedged chip and we re-enter
 * the 0-record loop the reset was trying to break.
 *
 * 18 s is the empirical floor — observed live 2026-05-21 on the POS
 * reader: stopping the agent entirely, waiting ~10 s, restarting always
 * unwedges (101 reads on the first cold spawn). Same effect with a 18 s
 * post-reset delay, without taking the rest of the fleet offline.
 *
 * The on-exit respawn timer (both stream and console drivers) is bumped
 * to `max(finalDelay, slot.bridgeResetAt + POST_BRIDGE_RESET_QUIET_MS -
 * now)` so this honors any reset fired during the current 0-byte streak.
 */
const POST_BRIDGE_RESET_QUIET_MS = 5_000;

/**
 * Fast-stuck detection: number of consecutive `cleanExit:true, totalRecords:0`
 * with duration under FAST_CLEAN_EXIT_THRESHOLD_MS that triggers an immediate
 * bridge reset, bypassing the silence-timer countdown. The 14:12-worked /
 * 17:01-broke episode of 2026-05-21 spent hours in this exact pattern
 * (180 ms cleanExit:true 0 records, 5 s respawn, repeat) without the
 * silence-watchdog ever firing because each spawn briefly reset the timer.
 * 3-strike + sub-1s exit means we react inside ~3 s of detection and the
 * full kill+bridge-reset+respawn loop completes inside the 15-s SLO.
 */
const FAST_CLEAN_EXIT_STRIKES = 3;
const FAST_CLEAN_EXIT_THRESHOLD_MS = 1_000;

/**
 * After this many fast-stuck → bridge-reset cycles fail in a row, escalate
 * to a chip-level reset (R2000 reset opcode via `new_monsoonreader
 * --reset`). The prior agent's f8b3ac7 fired this on EVERY 60-s silence
 * kick, which beat the chip into the UART break loop. Here it's gated on
 * actual evidence that bridge-reset isn't working (5 consecutive
 * fast-stuck cycles ≈ 60 s of failed bridge-only recovery) and
 * rate-limited by CHIP_RESET_COOLDOWN_MS so a chronically-bad chip
 * gets at most one chip-reset per cooldown window.
 */
const FAST_STUCK_CHIP_RESET_AFTER_CYCLES = 5;
const CHIP_RESET_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Grace window between SIGTERM and SIGKILL when stopping a slot's child.
 * `new_monsoonreader` catches SIGTERM and FINs its bridge TCP socket
 * within ~300 ms; we wait a touch longer for safety. SIGKILL fallback
 * fires if the child ignores SIGTERM (old MonsoonReader, wiznet-cli).
 * See `killSlotChildHard` for the leaked-session-on-SIGKILL backstory.
 */
const GRACEFUL_KILL_GRACE_MS = 1_500;

/**
 * Slow-detection window (rolling): how often we compare each slot's
 * read rate to its peers. A slot reading significantly slower than peer
 * median while peers are healthy gets auto-recovered (sweep + bridge
 * reset). Prevents the "slow" health badge from being a steady state —
 * operators shouldn't have to babysit it.
 */
const SLOW_DETECTION_WINDOW_MS = 60_000;
/** Slot is slow if its rate < SLOW_FRACTION * peer_median */
const SLOW_FRACTION_OF_MEDIAN = 0.25;
/** Don't bother with slow detection unless there are at least this many
 *  peer slots producing reads (avoids false positives at night or when
 *  most of the fleet is paused). */
const SLOW_MIN_PEERS = 3;
/** Peer median must be at least this many records/window for slow
 *  detection to fire. Otherwise we're in a low-activity baseline and
 *  one outlier reading slowly doesn't mean anything. */
const SLOW_MIN_PEER_RECORDS = 300;
/**
 * Wedge-level escalation. The slow-detect cycle runs at SLOW_DETECTION_WINDOW_MS
 * (60s). We track the timestamps of every slow-detect firing per slot in a
 * rolling window and escalate the recovery action based on how many fires
 * happened recently:
 *
 *   - Level 0: not slow — nothing tracked.
 *   - Level 1 (1-2 attempts in 5 min): bridge reset + binary kill+respawn.
 *     The standard recovery, applies on every slow tick.
 *   - Level 2 (>= LEVEL_2_COUNT attempts in 5 min): the chip didn't recover
 *     under standard recovery. Run a one-shot DEEP recovery: wiznet-cli
 *     baud renegotiate + mode-server rewrite + port rewrite + reset. This
 *     forces a full bridge re-init from NVRAM. Throttled by
 *     DEEP_RECOVERY_COOLDOWN_MS so we don't thrash.
 *   - Level 3 (>= LEVEL_3_COUNT attempts in 10 min): the chip is wedged below
 *     software reach. STOP the recovery loop on this slot — keep the binary
 *     running so any natural recovery is visible, but no more bridge resets
 *     or respawns. Set wedgedSinceMs so the heartbeat reports
 *     `chassis_wedged_at` to WMS, which surfaces a "needs hardware service"
 *     badge in Hardware Config. Operator gets a clear signal instead of
 *     the supervisor silently looping forever.
 *
 * Counters reset to 0 the moment a slot starts producing reads at or above
 * 50% of peer median — the chip naturally recovered, no service needed.
 */
const WEDGE_WINDOW_5MIN_MS = 5 * 60_000;
const WEDGE_WINDOW_10MIN_MS = 10 * 60_000;
const WEDGE_LEVEL_2_COUNT = 3;
const WEDGE_LEVEL_3_COUNT = 6;
const DEEP_RECOVERY_COOLDOWN_MS = 3 * 60_000;
/**
 * Upward-power probe cadence + step. When a slot is healthy at a power
 * below MAX, the supervisor periodically bumps the configured power +N
 * dBm to see if the chip can sustain higher output. If reads keep flowing
 * at the new power, it sticks (the suggestion auto-apply path on the
 * heartbeat handler writes the new configured value to devices.config).
 * If the chip silences, the existing sweep + auto-apply chain walks back
 * down to the working value. Net effect: supervisor always tends toward
 * MAX productive power without operator intervention.
 *
 * 5-min cadence is the right trade-off between "discover recovery fast"
 * and "don't churn the chip every few seconds." 2 dBm step matches the
 * sweep granularity. MAX_DBM caps the climb at the radio's regulatory
 * ceiling.
 */
const UPWARD_PROBE_INTERVAL_MS = 60_000;
const UPWARD_PROBE_STEP_DBM = 2;
const UPWARD_PROBE_MAX_DBM = 33;

/**
 * Supervisor-managed antenna multiplexing for multi-antenna readers.
 * Replaces the chassis-side `--cmux --mxa N1,N2 --mux_cycles -1` invocation,
 * which on at least one production chassis (.16, Transfer Bin) never produced
 * reads from antenna 1 in mux mode while standalone single-antenna tests
 * worked on both antennas. Verified 2026-05-09: 1,811 reads from antenna 2,
 * zero from antenna 1 in chassis-cmux mode.
 *
 * Replacement: the supervisor itself rotates antennas. For each enabled
 * antenna in turn we spawn a single-antenna console-driver child for
 * SUPERVISOR_MUX_INTERVAL_MS, then kill+respawn for the next antenna.
 * Each antenna gets focused-scan throughput at the chassis level (no
 * mux switching inside the chassis at all). Cross-antenna dedup on the
 * EPC side prevents the same tag from counting twice when sighted on
 * both antennas within a swap cycle.
 */
const SUPERVISOR_MUX_INTERVAL_MS = 5_000;
/**
 * Candidate Monsoon-over-Ethernet ports. The first time a reader spawns
 * we use the operator-configured port; if the resulting child stays silent
 * (zero bytes before the watchdog kicks at STREAM_SILENCE_TIMEOUT_MS), we
 * rotate to the next candidate. Operator never needs to know which port
 * their WIZnet bridge is on — adding the reader's IP is enough.
 *   10002 — Senitron-configured WIZnet factory image
 *    1461 — WIZnet WIZ100SR/110SR/140SR factory default data-tunnel port
 */
/**
 * DISABLED 2026-05-12: was [10002, 1461]. The 1461 fallback was for
 * factory-fresh WIZnet bridges before commissioning. Today the agent
 * also runs LAN-wide `wiznet-cli -d` discovery and auto-updates
 * `monsoon_serial_port` in the WMS, so the configured port is always
 * the right port. Keeping 1461 in the rotation made things worse:
 * a chip that briefly went silent on its configured port (10002) was
 * rotated to 1461, which can never produce reads because that's the
 * config port, not the data tunnel. Catch-22 — supervisor stayed on
 * the wrong port forever. Confirmed live 2026-05-12 on .15/.77/.78/
 * .81/.82 cycling silent at port 1461 for hours.
 *
 * Kept the constant + function shape so any future need (e.g. an
 * uncommissioned bridge on the floor) can be solved at the discovery
 * layer, not by blind port rotation.
 */
const SERIAL_PORT_FALLBACKS: readonly number[] = [];

function buildCandidatePorts(configured: number): number[] {
  const p = Number.isFinite(configured) && configured > 0 ? configured : 10002;
  return [p, ...SERIAL_PORT_FALLBACKS.filter((f) => f !== p)];
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
   * Consecutive console-driver spawns that exited cleanly (no signal,
   * code 0) with zero records in under FAST_CLEAN_EXIT_THRESHOLD_MS.
   * This is the signature of a chip in a stuck state where the binary's
   * setup handshake fails fast — the silence-watchdog never fires
   * because each spawn briefly resets the byte-timer. After
   * FAST_CLEAN_EXIT_STRIKES strikes, we trigger an immediate
   * bridge reset to break the loop inside the 15-s SLO. Reset on any
   * byte received or on a non-fast / non-clean exit.
   */
  consecutiveFastCleanExits: number;
  /**
   * Consecutive fast-stuck CYCLES (each = FAST_CLEAN_EXIT_STRIKES strikes +
   * one bridge reset that failed to clear it). Resets the moment a byte
   * is received. Used to escalate from bridge-reset-only recovery to
   * chip-level reset after FAST_STUCK_CHIP_RESET_AFTER_CYCLES.
   */
  fastStuckCycles: number;
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
  /** Records counted in the current 60-s rate window. Used by the slow-
   *  detection watchdog to compare a slot's read rate against peer slots'
   *  median rate. If this slot is significantly slower than peers AND
   *  it's not in mux mode, the watchdog auto-triggers sweep recovery.
   *  Reset every SLOW_DETECTION_WINDOW_MS by runStreamWatchdog. */
  recordsThisWindow: number;
  /** ms timestamp when recordsThisWindow started counting. */
  recordWindowStartAt: number;
  /** ms timestamp of the most recent slow-recovery trigger. Throttled by
   *  SWEEP_RETRY_COOLDOWN_MS so a permanently-slow chip doesn't thrash. */
  lastSlowRecoveryAt: number;
  /** Rolling list of ms timestamps for slow-recovery attempts. Pruned to
   *  WEDGE_WINDOW_MS by the detector. Drives the wedge-level escalation:
   *  >= WEDGE_LEVEL_2_COUNT attempts → deep recovery; >= WEDGE_LEVEL_3_COUNT
   *  → mark `needs hardware service`, stop the recovery loop. */
  slowRecoveryAttemptTimes: number[];
  /** Current wedge level: 0=healthy, 1=slow, 2=deep-recovery-attempted,
   *  3=hardware-wedged (no more software recovery, push UI signal). */
  wedgeLevel: 0 | 1 | 2 | 3;
  /** ms timestamp when wedge transitioned to Level 3 (signals UI). 0 = not
   *  wedged. Used by heartbeat to push `chassis_wedged_at` to WMS. */
  wedgedSinceMs: number;
  /** When the supervisor's auto-sweep found a sub-configured power that
   *  produces reads (chip alive but configured power is too high — typical
   *  signature of VSWR/antenna-mismatch hitting the R2000's transmit safety),
   *  stash that working power in dBm here. Heartbeat pushes it to WMS as a
   *  `suggested_power_dbm` on the reader's antennas; Hardware Config surfaces
   *  a one-click "apply" banner so the operator can lower the configured
   *  power without rummaging through editor modals. NULL = no suggestion. */
  suggestedPowerDbm: number | null;
  /** ms timestamp of the last forced-respawn fired for this slot (from
   *  spec.force_respawn_interval_ms). 0 = never. Used by the watchdog to
   *  decide when the next forced respawn is due. Reset on spawn so the
   *  timer counts from each fresh binary. */
  lastForcedRespawnAt: number;
  /** ms timestamp of the last upward power probe. Every UPWARD_PROBE_
   *  INTERVAL_MS, the supervisor bumps configured power +2 dBm when the
   *  slot is reading at a sub-MAX power, so a chip that's been stable at
   *  a low auto-applied power keeps testing whether it can climb back
   *  toward the radio's 33 dBm ceiling. If the bump silents the chip, the
   *  existing sweep loop walks back down and auto-applies the lower
   *  working value. Net effect: supervisor always tries to maximize
   *  productive power without operator intervention. */
  lastUpwardProbeAt: number;
  /** ms timestamp of the most recent deep-recovery attempt (Level 2 action).
   *  Throttled by DEEP_RECOVERY_COOLDOWN_MS so we don't re-deep-recover on
   *  every slow-detect tick while at Level 2. */
  lastDeepRecoveryAt: number;
  /** ms timestamp of the most recent `wiznet-cli --reset` for this slot's
   *  bridge. 0 = never. Used by the on-exit respawn timer to enforce a
   *  POST_BRIDGE_RESET_QUIET_MS window before the next spawn so the bridge +
   *  chip can fully reboot before the supervisor reconnects. Without this
   *  the supervisor races the reset and re-wedges the chip immediately,
   *  observed live 2026-05-21 on POS reader (.69) — bridge reset succeeded
   *  but auto-sweep respawned 5 s later while the chip was mid-reboot,
   *  every spawn returned 0 records, only `systemctl stop carbon-cdm-agent
   *  + 10s pause + start` broke the loop. */
  bridgeResetAt: number;
  /** ms timestamp of the most recent `new_monsoonreader --reset` chip-level
   *  reset fired by `tryChipReset`. 0 = never. Used by tryChipReset to
   *  enforce a CHIP_RESET_COOLDOWN_MS gap between firings so we don't
   *  damage a chip the way the every-60s f8b3ac7 commit did 2026-05-21
   *  afternoon. Chip reset is reserved for true wedges where bridge
   *  reset alone hasn't cleared the fast-stuck pattern after multiple
   *  attempts. */
  chipResetAt: number;
  /** ms timestamp of the most recent push to /api/cdm-agents/reader-offline.
   *  Throttle so a chronically-silent reader posts offline once per minute,
   *  not on every watchdog tick. Reset to 0 on first-byte (online) so the
   *  next silence period gets an immediate offline push. */
  lastOfflinePushAt: number;
  /** Mirror of the WMS-side status_online state from THIS agent's perspective.
   *  Flips true on the first byte from the chip; flips false when the silence
   *  watchdog fires an offline push. Used to gate the on-transition callbacks
   *  so we don't re-push the same state. */
  lastReportedOnline: boolean;
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
  /**
   * Set to true when the supervisor itself initiates a kill (enterTestMode
   * or leaveTestMode) so the on-exit handler knows to respawn fast (~250ms)
   * and not grow backoff. Without this, a deliberate kill looks identical
   * to a SIGKILL fault and the on-exit handler waits up to MAX_BACKOFF_MS
   * (60s) before respawning — the test child never warms up before the
   * /antenna-test session ends, and the operator sees zero EPCs in the UI.
   * Reset to false after the on-exit handler consumes it.
   */
  intendedKill: boolean;
  /**
   * When non-null, the next spawn(s) override the configured transmit power
   * with this value. Used by the auto-sweep recovery state machine to walk
   * a stuck radio through SWEEP_POWERS until something un-sticks it. Cleared
   * on first-byte (recovery succeeded) or after the sweep exhausts all
   * power steps (recovery failed). See SWEEP_POWERS comment for context.
   */
  sweepPowerOverrideArg: number | null;
  /**
   * ms timestamp of the last completed sweep recovery attempt (success OR
   * failure). Throttled to once per SWEEP_RETRY_COOLDOWN_MS so a permanently
   * broken reader doesn't sweep-thrash indefinitely. 0 = never attempted.
   */
  lastSweepAttemptAt: number;
  /**
   * ms timestamp when the current sweep STEP started. Used to enforce
   * MIN_SWEEP_DWELL_MS so a sub-second 0-byte exit can't bounce the
   * sweep past a power that would actually have worked given a few
   * more seconds of chip warm-up.
   */
  sweepStepStartedAt: number;
  /**
   * Supervisor-managed antenna mux. When `length >= 2`, we rotate through
   * these antenna numbers (one console-driver child per antenna) in place
   * of relying on the chassis's --cmux mode. Empty/length=1 means no
   * supervisor mux (single-antenna reader uses its enabled antenna directly).
   * Built once at slot init from the spec's enabled antennas.
   */
  muxAntennaSequence: number[];
  /** Current position in muxAntennaSequence (0-indexed). The active console
   *  spawn stamps reads with `muxAntennaSequence[muxCurrentIdx]`. */
  muxCurrentIdx: number;
  /** ms timestamp at which the current antenna's window expires and the
   *  watchdog should rotate to the next antenna. Set to now+interval on each
   *  rotation; the watchdog tick checks this and triggers the swap. */
  muxSwapAtMs: number;
  /** ms timestamp when this slot was created (NOT respawned — this is set
   *  once at slot allocation and survives across child respawns). Compared
   *  against `spec.reader_recover_requested_at` on reconcile: if the WMS
   *  stamp is newer than slotCreatedAt, the admin clicked Hard Reset after
   *  this slot was born and we must tear it down and recreate from scratch
   *  (fresh sweep budget, fresh candidate-port index, fresh exhaustion
   *  state). The freshly-created slot's slotCreatedAt > recover_requested_at,
   *  so the same stamp won't keep retriggering. */
  slotCreatedAt: number;
  /**
   * Pending stopSlot belt-and-braces abort timer. stopSlot() schedules
   * `ensureRadioStopped()` 11 s after kill to GUARANTEE the chip's radio
   * stops. But if the slot gets a fresh child spawned before that timer
   * fires (e.g. operator hits Stop-all then Start-all within 11 s, or a
   * scan-session wakes the reader), the stale abort lands on the NEW
   * child's chip and silently sabotages its inventory — every reader in
   * the fleet ends up cycling silent. Bug observed live 2026-05-11. We
   * track the timer handle here so the next spawn can cancel it.
   *
   * null = no pending abort timer.
   */
  pendingAbortTimer: ReturnType<typeof setTimeout> | null;
  /**
   * ms timestamp of the last ensureRadioStopped fired for this slot.
   * Gate for the on-exit (0-byte) abort path — without it, the abort
   * fires every ~5 s during a respawn loop, which puts the chip into
   * the exact post-RadioAbortOperation wedge state the abort was meant
   * to recover from. The counter we tried to use (consecutiveZeroByteKicks)
   * is reset by auto-sweep recovery at line 720, so we use an
   * independent timestamp here. Aborts within ABORT_COOLDOWN_MS of the
   * last one are skipped. 0 = never aborted.
   */
  lastAbortAt: number;
};

/** Minimum wall-clock between consecutive on-exit aborts per slot. Long
 *  enough to give the chip a real chance to respond to fresh inventory
 *  commands without being kicked back into wedge. 30 s matches the
 *  sweep-recovery cooldown elsewhere in this file. */
const ABORT_COOLDOWN_MS = 30_000;

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
 * production setting). Tightened from 60s → 20s on 2026-05-12 after live
 * evidence that bridge-side wedges (chip silent on a healthy bridge) need
 * faster respawn cycles to break the lock. Each respawn re-sends
 * RFID_RadioAbortOperation + chip init; faster cadence gives the chip more
 * shots at breaking out of a TagFocus/session-state lock per minute.
 * Tradeoff: a genuinely quiet 30-60s warehouse moment will trip a respawn.
 * That respawn is cheap (~2s end-to-end) and reads resume immediately
 * once tags re-enter the antenna's field, so the cost is invisible.
 */
const STREAM_SILENCE_TIMEOUT_MS = 20_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/**
 * Throttle for /api/cdm-agents/reader-offline pushes. A reader sitting
 * unplugged for hours triggers the silence watchdog every 5 s; without a
 * throttle we'd hammer the WMS endpoint. 60 s is generous — once per minute
 * is enough to self-heal a stuck server-side status row, while imposing
 * negligible request load.
 */
const OFFLINE_PUSH_THROTTLE_MS = 60_000;
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
const READ_RATE_DROP_TIMEOUT_MS = 20_000;
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
  /**
   * Lowest-free slot-index allocator. Each running reader owns a unique
   * `index` in [0, ∞) used to derive its TCP listen ports
   * (`STREAM_PORT_BASE + index`, `CONTROL_PORT_BASE + index`). When a slot
   * is removed (pause / scan-session end / reader unconfigured), its index
   * is freed back here for reuse — instead of being effectively reclaimed
   * by `nextIndex = this.slots.size` which produced collisions any time a
   * NON-LAST slot was removed and then re-added (the new slot got the
   * size-based index, which collided with a still-running higher-index
   * slot's stream port). Live-evidence 2026-05-09 prod journal showed
   * recurring `streamPort:30107` reuse across the .18→.81→.22→.18 churn
   * pattern. With this allocator the next freed index is reused, so the
   * total port range stays small and unique.
   */
  private usedIndexes = new Set<number>();
  private allocateSlotIndex(): number {
    for (let i = 0; ; i++) {
      if (!this.usedIndexes.has(i)) {
        this.usedIndexes.add(i);
        return i;
      }
    }
  }
  private freeSlotIndex(idx: number): void {
    this.usedIndexes.delete(idx);
  }
  private testSweepHandle: NodeJS.Timeout | null = null;
  private streamWatchdogHandle: NodeJS.Timeout | null = null;
  /** Set of antenna IDs we've already started a test for (one-shot per pending). */
  private testedAntennas = new Set<string>();
  /** Reader IDs that have an ACTIVE workflow scan-session (Transfer Out /
   *  Cycle Counts / Print-Commission). Reconcile treats these as un-paused
   *  even when bundle.effective_paused = true. Updated every ~250ms by the
   *  agent's active-sessions poll handler. Default state in the new model
   *  is "every reader paused"; this set is the wake mechanism. */
  private activeScanSessionReaders = new Set<string>();
  /** Reader IDs that have an in-flight Antenna Test. Same wake mechanism
   *  as activeScanSessionReaders but populated by enterTestMode() so a
   *  paused reader can run a one-off antenna test from the WMS UI, then
   *  go back to paused on leaveTestMode(). Without this set, the UI's
   *  "Antenna Test" button silently no-op'd on paused readers: the
   *  supervisor logged "enterTestMode for unknown reader" because no slot
   *  existed (paused → filtered out of reconcile), the WMS still showed
   *  green/ready, but no tags were ever read. Observed live 2026-05-21
   *  on the POS reader (.69, cbbeffbd) — 4 test sessions in a row all
   *  warning "unknown reader". */
  private testWakeReaders = new Set<string>();
  /** Last-bundle reference so setActiveScanSessionReaders can reconcile
   *  immediately on session change without waiting for the next config-pull. */
  private lastBundle: AgentConfigBundle | null = null;

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
    /**
     * Optional: fires the first time a child binary produces ANY byte on
     * its stream/stdout AFTER the slot has been in offline state — the
     * agent can talk to the chassis even before any tag reads arrive.
     * Wire this to wms-client.postReaderOnline so the dashboard reflects
     * "chassis reachable" independent of "tags currently flowing." Fires
     * only on offline→online transitions so stuck-binary respawn cycles
     * don't spam the WMS.
     */
    private readonly onReaderOnline: ((readerId: string) => void) | null = null,
    /**
     * Optional: fires when the silence watchdog detects the chip has
     * gone silent (>=60s zero bytes from the chassis). Wire this to
     * wms-client.postReaderOffline so the WMS flips status_online=false
     * promptly when a reader drops off the network. Throttled to ~once
     * per minute per slot to avoid spamming the WMS while a reader is
     * chronically unreachable (e.g., unplugged for hours). Will fire
     * on online→offline transitions AND periodically while offline,
     * so a server-side row stuck at status_online=true (e.g., from a
     * prior agent run that crashed before reporting offline) self-heals.
     */
    private readonly onReaderOffline: ((readerId: string) => void) | null = null,
    /**
     * Optional: fires when a reader is removed from the desired-set during
     * reconcile (deleted in WMS, paused without an active session, etc.).
     * Wire this to ReadAggregator.flushAndDrop so any reads still buffered
     * for that reader stop being retried. Without this, a long WMS outage
     * during a reader-removal event leaves the queue alive in memory forever
     * — bounded by MAX_QUEUE_PER_READER but still a small leak per delete.
     */
    private readonly onReaderRemoved: ((readerId: string) => void) | null = null,
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

  /**
   * Tell the WMS this reader is currently offline (chip silent past the
   * watchdog threshold). Throttled per-slot via OFFLINE_PUSH_THROTTLE_MS so
   * a chronically-silent reader posts at most once per minute. Flips the
   * slot's lastReportedOnline mirror to false on the first push of a
   * silence period. Subsequent throttled re-pushes self-heal a server-side
   * status row stuck at true (e.g., from a prior agent run that crashed
   * before reporting offline).
   */
  private pushReaderOfflineIfDue(slot: ReaderSlot, now: number): void {
    if (now - slot.lastOfflinePushAt < OFFLINE_PUSH_THROTTLE_MS) return;
    slot.lastOfflinePushAt = now;
    slot.lastReportedOnline = false;
    try {
      this.onReaderOffline?.(slot.spec.id);
    } catch {
      /* never let a callback exception kill the watchdog loop */
    }
  }

  /**
   * Update the set of reader IDs that have an active workflow scan-session.
   * Called from the agent's active-sessions poll handler ~every 250 ms.
   * Triggers an immediate reconcile only if the set actually changed —
   * avoids spinning every poll tick when nothing changed.
   */
  setActiveScanSessionReaders(readerIds: Set<string>): void {
    const prev = this.activeScanSessionReaders;
    if (prev.size === readerIds.size) {
      let same = true;
      for (const id of prev) {
        if (!readerIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.activeScanSessionReaders = new Set(readerIds);
    if (this.lastBundle) this.reconcile(this.lastBundle);
  }

  /**
   * Stop the slot's current child. SIGTERM the process group first to give
   * `new_monsoonreader` (which catches SIGTERM as of 2024) a chance to send
   * FIN on its bridge-side TCP socket; if it's still alive after
   * GRACEFUL_KILL_GRACE_MS, SIGKILL the group.
   *
   * Why graceful first: SIGKILL drops the child mid-syscall, leaving the
   * WIZnet bridge holding a half-open TCP session that registers as
   * HasClient=Y. The bridge is SERVER(2) mode = single-client, so every
   * leaked session blocks the next supervisor spawn until the bridge's own
   * TCP timeout reaps it (minutes). Live 2026-05-21 on POS reader: 93
   * silence-watchdog cycles in one afternoon each leaked a session, until
   * the bridge stopped accepting new connections entirely and reads stayed
   * at 0 for hours. The antenna-test leaveTestMode path already uses this
   * pattern (see "GRACEFUL SHUTDOWN 2026-05-12" below).
   *
   * Old MonsoonReader (stream driver) and wiznet-cli ignore SIGTERM (per
   * 2026-05-07 evidence) — the SIGKILL fallback handles them.
   */
  private killSlotChildHard(slot: ReaderSlot): void {
    const pid = slot.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { slot.child?.kill("SIGTERM"); } catch { /* already gone */ }
    }
    setTimeout(() => {
      const child = slot.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }
    }, GRACEFUL_KILL_GRACE_MS);
  }

  private runStreamWatchdog(): void {
    const now = Date.now();
    for (const slot of this.slots.values()) {
      if (slot.shuttingDown) continue;
      // DEFENSIVE 2026-05-12: mux readers should NEVER have a sweep
      // override (auto-sweep skips mux, slow-detection skips mux).
      // But .16 was observed today running pinned to antenna 2 with
      // a non-null sweepPowerOverrideArg, which suppressed mux swaps.
      // Until the source is traced, defensively clear any sweep state
      // from mux slots on every watchdog tick AND reset muxSwapAtMs so
      // the swap window can't be stuck in the future.
      if (slot.muxAntennaSequence.length >= 2) {
        if (slot.sweepPowerOverrideArg !== null) {
          log.warn("supervisor: defensively clearing sweepPowerOverrideArg on mux slot", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            stalePower: slot.sweepPowerOverrideArg,
          });
          slot.sweepPowerOverrideArg = null;
          slot.lastSweepAttemptAt = 0;
        }
        // Force mux swap to be due soon if it's somehow stuck in the
        // future (>SUPERVISOR_MUX_INTERVAL_MS * 2). This catches the
        // pathological state where the watchdog never triggers a swap
        // because muxSwapAtMs was set far ahead by a stale spawn path.
        if (slot.muxSwapAtMs > now + SUPERVISOR_MUX_INTERVAL_MS * 2) {
          log.warn("supervisor: muxSwapAtMs stuck in far future on mux slot — resetting", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            muxSwapAtMs: slot.muxSwapAtMs,
            now,
          });
          slot.muxSwapAtMs = now;
        }
      }
      // Periodic auto-retest of operator-configured power. When sweep
      // recovery pinned the slot to a sub-configured power earlier,
      // we keep it there long enough for the reader to actually be
      // useful, then drop the pin and try the configured power again.
      // If the chip has genuinely recovered, this restores it to the
      // operator's chosen power. If not, sweep just re-pins.
      if (
        slot.sweepPowerOverrideArg !== null &&
        slot.lastSweepAttemptAt > 0 &&
        now - slot.lastSweepAttemptAt >= SWEEP_OVERRIDE_RETEST_MS
      ) {
        log.info("supervisor: re-testing configured power after sweep pin", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          previousPinnedPower: slot.sweepPowerOverrideArg,
          pinnedForMs: now - slot.lastSweepAttemptAt,
        });
        slot.sweepPowerOverrideArg = null;
        slot.lastSweepAttemptAt = 0;
        slot.consecutiveZeroByteKicks = 0;
        slot.bytesSinceSpawn = false;
        if (slot.child) {
          slot.intendedKill = true;
          this.killSlotChildHard(slot);
        }
      }
      if (!slot.child) continue;

      // Per-reader forced-respawn cadence. Some chassis exhibit chip-firmware
      // session-state degradation under long-running `--infinite` mode — the
      // chip emits reads for the first 10-20s after spawn, then silences
      // even though the binary, bridge, and TCP are all healthy. Antenna-
      // test sweep mode masks the bug because each sweep step naturally
      // kills+respawns the binary every few seconds, so the chip's session
      // state never has time to degrade. This setting reproduces that
      // freshness in normal scanning — when `force_respawn_interval_ms` is
      // set on the reader's config (devices.config.force_respawn_interval_ms),
      // the supervisor kills the child every N ms and lets the on-exit
      // respawn re-init the chip with RFID_RadioAbortOperation + radio
      // config. Skipped during TEST_MODE (operator owns the slot) and
      // sweep recovery (the recovery state machine owns the slot).
      const forceMs = Number(slot.spec.force_respawn_interval_ms ?? 0);
      if (
        forceMs > 0 &&
        slot.testSession === null &&
        slot.sweepPowerOverrideArg === null &&
        slot.lastForcedRespawnAt > 0 &&
        now - slot.lastForcedRespawnAt >= forceMs
      ) {
        log.info("supervisor: forced respawn — chip-state refresh cadence", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          forceMs,
          msSinceLastRespawn: now - slot.lastForcedRespawnAt,
        });
        slot.lastForcedRespawnAt = now;
        slot.intendedKill = true;
        this.killSlotChildHard(slot);
        continue;
      }
      // Initialize the timer on first watchdog tick after spawn so the
      // first interval doesn't fire immediately.
      if (forceMs > 0 && slot.lastForcedRespawnAt === 0) {
        slot.lastForcedRespawnAt = now;
      }

      // ── Upward-power probe ──
      // Periodically bump configured power +UPWARD_PROBE_STEP_DBM dBm while
      // the slot is reading at a sub-MAX power. Gives a chip that was
      // auto-applied to a low power (because of transient session-state
      // problems, brief VSWR trips, etc.) a chance to climb back toward the
      // radio ceiling autonomously. If the bump silences the chip, the
      // existing silence-watchdog → sweep → auto-apply chain walks back
      // down to the working value, so the probe is self-correcting.
      //
      // Gates:
      //   - Not in TEST_MODE (operator owns the slot)
      //   - Not in sweep recovery (slot already cycling)
      //   - Healthy: producing bytes (lastByteAt fresh)
      //   - Configured power < UPWARD_PROBE_MAX_DBM (don't probe above
      //     the radio's regulatory ceiling)
      //   - UPWARD_PROBE_INTERVAL_MS elapsed since last probe
      const probeConfiguredDbm = Math.round(this.avgPower(slot.spec));
      if (
        slot.testSession === null &&
        slot.sweepPowerOverrideArg === null &&
        slot.bytesSinceSpawn &&
        now - slot.lastByteAt < 5_000 &&
        probeConfiguredDbm < UPWARD_PROBE_MAX_DBM &&
        slot.lastUpwardProbeAt > 0 &&
        now - slot.lastUpwardProbeAt >= UPWARD_PROBE_INTERVAL_MS
      ) {
        const probeDbm = Math.min(
          probeConfiguredDbm + UPWARD_PROBE_STEP_DBM,
          UPWARD_PROBE_MAX_DBM,
        );
        log.info("supervisor: upward probe — bumping configured power", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          fromDbm: probeConfiguredDbm,
          toDbm: probeDbm,
        });
        // Reuse the existing suggestion mechanism — the heartbeat handler
        // writes suggested_power_dbm AND config.transmit_power_dbm in one
        // pass (auto-apply). Same flow used when sweep finds a lower
        // working power; here we use it upward.
        slot.suggestedPowerDbm = probeDbm;
        slot.lastUpwardProbeAt = now;
      }
      // Initialize the probe timer on first watchdog tick after the slot
      // is healthy so the first interval counts from now, not from epoch.
      if (slot.lastUpwardProbeAt === 0 && slot.bytesSinceSpawn) {
        slot.lastUpwardProbeAt = now;
      }

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
        this.killSlotChildHard(slot);
        continue;
      }

      // Multi-antenna mux mode: the legacy binary produces records in
      // ~15-25 second bursts then goes silent (boost-thread state quirk).
      // Use a tighter watchdog window so respawn happens fast — gets us
      // back to productive scanning instead of waiting 60 s per cycle.
      // Startup latency for mux mode is ~7-10 s (radio enumerate + first
      // mux cycle); 15 s silence threshold leaves headroom while keeping
      // dead-cycle waste minimal.
      const muxSlot = slot.spec.antennas.filter((a) => a.enabled).length >= 2;
      const silenceTimeout = muxSlot ? 15_000 : STREAM_SILENCE_TIMEOUT_MS;
      const rateDropTimeout = muxSlot ? 12_000 : READ_RATE_DROP_TIMEOUT_MS;

      // For mux readers, suppress the "rotate ports on zero-bytes" branch.
      // Mux startup naturally has zero bytes for ~7-10 s — port rotation
      // would flip-flop between ports unnecessarily and waste recovery time.
      // We still rotate non-mux readers (the original behavior).
      const silentMs = now - slot.lastByteAt;
      // Tell the WMS this reader is offline as soon as silence persists
      // past the watchdog threshold. Throttled so a long-silent reader
      // doesn't hammer the endpoint. Fires regardless of which recovery
      // branch (rotate / kick / exhaustion) we take below.
      if (silentMs >= silenceTimeout) {
        this.pushReaderOfflineIfDue(slot, now);
      }
      // Supervisor-managed antenna mux: rotate antennas on the configured
      // interval. Skipped during TEST_MODE (the antenna-test endpoint owns
      // the antenna selection while a session is open) and during sweep
      // recovery (we want power-step focus, not antenna-step focus).
      if (
        slot.muxAntennaSequence.length >= 2 &&
        !slot.shuttingDown &&
        slot.testSession === null &&
        slot.sweepPowerOverrideArg === null &&
        now >= slot.muxSwapAtMs
      ) {
        const prevAntenna = slot.muxAntennaSequence[slot.muxCurrentIdx];
        slot.muxCurrentIdx = (slot.muxCurrentIdx + 1) % slot.muxAntennaSequence.length;
        const nextAntenna = slot.muxAntennaSequence[slot.muxCurrentIdx];
        slot.muxSwapAtMs = now + SUPERVISOR_MUX_INTERVAL_MS;
        log.info("supervisor: mux swap — rotating to next antenna", {
          readerId: slot.spec.id,
          readerName: slot.spec.name,
          prevAntenna,
          nextAntenna,
          swapIntervalMs: SUPERVISOR_MUX_INTERVAL_MS,
        });
        if (slot.child) {
          slot.intendedKill = true;
          this.killSlotChildHard(slot);
        }
        continue;
      }

      // Auto-sweep recovery — when active, every silent kick advances the
      // power step. If a step produces bytes, the byte-arrival site clears
      // the override (recovery succeeded). If all steps go silent, give up
      // and fall through to normal exhaustion behavior.
      if (silentMs >= silenceTimeout && slot.sweepPowerOverrideArg !== null) {
        const idx = SWEEP_POWERS.indexOf(slot.sweepPowerOverrideArg);
        if (idx >= 0 && idx + 1 < SWEEP_POWERS.length) {
          const nextPower = SWEEP_POWERS[idx + 1];
          slot.sweepPowerOverrideArg = nextPower ?? null;
          slot.sweepStepStartedAt = Date.now();
          log.info("supervisor: sweep step silent — advancing power", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            prevPower: SWEEP_POWERS[idx],
            nextPower,
          });
        } else {
          log.warn("supervisor: sweep recovery failed — chassis silent at all power steps; triggering bridge reset", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            triedPowers: [...SWEEP_POWERS],
          });
          slot.sweepPowerOverrideArg = null;
          slot.lastSweepAttemptAt = now;
          // AUTO BRIDGE RESET 2026-05-12: when sweep recovery fails at
          // every power step, the chip is in a state that power-cycling
          // the inventory loop can't clear. Empirical evidence (today,
          // multiple readers): wiznet-cli --reset on the bridge IS what
          // unsticks these chips. So we run it automatically here. The
          // 60-s SWEEP_RETRY_COOLDOWN_MS then gives us a fast next
          // attempt that usually succeeds because the bridge reset
          // cleared the chip's stuck state.
          this.tryBridgeReset(slot.spec);
        }
        slot.lastByteAt = now;
        this.killSlotChildHard(slot);
        continue;
      }

      if (silentMs >= silenceTimeout && !exhaustedAllPorts) {
        if (!slot.bytesSinceSpawn && !muxSlot) {
          // Zero-byte kick: rotate to next candidate port if we have one.
          // Skipped for mux readers — mux startup is naturally slow and
          // rotating would flip-flop between working/factory ports.
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
        this.killSlotChildHard(slot);
      } else if (
        slot.lastRecordAt > 0 &&
        now - slot.lastRecordAt >= rateDropTimeout
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
        this.killSlotChildHard(slot);
      } else if (silentMs >= silenceTimeout && exhaustedAllPorts) {
        // We've tried every candidate port at least once without bytes.
        // Before declaring the chassis broken and waiting in cooldown, try
        // an auto-sweep: walk the transmit power across SWEEP_POWERS. A
        // power-level CHANGE forces the radio's RF stage to reconfigure
        // (PLL relock + calibration), which clears firmware-level stuck
        // inventory states that "Stop / Start inventory" alone can't.
        // Skip mux readers — their startup latency makes the sweep timing
        // unreliable; rely on the existing mux watchdog instead.
        // force_respawn gate: when the operator has explicitly configured
        // a forced respawn cadence on this reader (devices.config.
        // force_respawn_interval_ms), the operator has chosen the chip-
        // freshness strategy. The supervisor must NOT auto-sweep over that
        // choice — sweep would walk the configured power down to a
        // sub-configured value while force_respawn keeps respawning at the
        // configured value, creating a fight. Live evidence 2026-05-12:
        // .15 was set to 31 dBm with force_respawn 4s; auto-sweep walked
        // the same slot down to 22 dBm in parallel. Trust the operator's
        // explicit setting and skip sweep entry entirely.
        const forceConfigured = Number(slot.spec.force_respawn_interval_ms ?? 0) > 0;
        // Skip auto-sweep entirely when the operator has configured a power
        // below SWEEP_POWERS' minimum (30 dBm). Live evidence 2026-05-21 on
        // POS reader (.69, 17 dBm configured): sweep walked through
        // 330→310→290…→30, none of which match the operator's intent —
        // each spawn at the wrong power gave 0 records, leaving the slot
        // wedged forever. For low-power slots the recovery path that
        // actually works is "bridge reset + UART quiet + respawn at
        // configured power", which is what bridgeResetAt+POST_BRIDGE_RESET_
        // QUIET_MS implements. The on-exit 0-record path triggers
        // tryBridgeReset directly without needing sweep state.
        const configuredPower = this.avgPower(slot.spec);
        const minSweepPower = SWEEP_POWERS[SWEEP_POWERS.length - 1] ?? 30;
        const skipSweepLowPower = configuredPower < minSweepPower;
        if (
          !muxSlot &&
          slot.testSession === null &&
          slot.sweepPowerOverrideArg === null &&
          !forceConfigured &&
          !skipSweepLowPower &&
          now - slot.lastSweepAttemptAt >= SWEEP_RETRY_COOLDOWN_MS
        ) {
          // testSession gate: an active /antenna_test session owns this slot.
          // The operator is driving power/cycle/tagfocus from the test page;
          // the supervisor must not auto-sweep over their settings, even if
          // the chip is silent. Without this gate the test page shows "0 EPCs"
          // because the supervisor flipped the slot back to normal mode at a
          // lower power before the test's first read landed.
          slot.sweepPowerOverrideArg = SWEEP_POWERS[0] ?? null;
          slot.sweepStepStartedAt = Date.now();
          slot.consecutiveZeroByteKicks = 0;
          slot.lastExhaustionResetAt = 0;
          slot.bytesSinceSpawn = false;
          slot.lastByteAt = now;
          log.info("supervisor: starting auto-sweep recovery", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            host: slot.spec.network_address,
            firstSweepPower: slot.sweepPowerOverrideArg,
          });
          this.killSlotChildHard(slot);
          continue;
        }
        // Low-power slots take the direct bridge-reset path: silence at
        // configured power for SWEEP_RETRY_COOLDOWN_MS → fire bridge reset
        // (rate-limited) → POST_BRIDGE_RESET_QUIET_MS quiet → respawn at
        // configured power. No power-sweep theatrics that would override
        // the operator's deliberate setting.
        if (
          !muxSlot &&
          slot.testSession === null &&
          slot.sweepPowerOverrideArg === null &&
          !forceConfigured &&
          skipSweepLowPower &&
          !slot.bytesSinceSpawn &&
          now - slot.lastSweepAttemptAt >= SWEEP_RETRY_COOLDOWN_MS &&
          now - slot.bridgeResetAt >= SWEEP_RETRY_COOLDOWN_MS
        ) {
          // Count this as a stuck cycle so the chip-reset escalator can
          // kick in even when the binary exits cleanly after 20-25s
          // (which doesn't trigger the FAST_CLEAN_EXIT detection path).
          // Same FAST_STUCK_CHIP_RESET_AFTER_CYCLES threshold + cooldown
          // as the console-driver fast path. Resets when bytes arrive.
          slot.fastStuckCycles += 1;
          const sinceLastChipReset = Date.now() - slot.chipResetAt;
          const chipResetAllowed =
            slot.fastStuckCycles >= FAST_STUCK_CHIP_RESET_AFTER_CYCLES &&
            sinceLastChipReset >= CHIP_RESET_COOLDOWN_MS;
          if (chipResetAllowed) {
            log.warn("supervisor: low-power bridge-reset cycles exhausted — escalating to chip-level reset", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              host: slot.spec.network_address,
              fastStuckCycles: slot.fastStuckCycles,
              cooldownAgoMs: slot.chipResetAt === 0 ? null : sinceLastChipReset,
            });
            slot.fastStuckCycles = 0;
            slot.chipResetAt = Date.now();
            slot.lastSweepAttemptAt = Date.now();
            this.tryChipReset(slot.spec);
          } else {
            log.info("supervisor: low-power slot stuck — direct bridge reset (no sweep)", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              host: slot.spec.network_address,
              configuredPower,
              fastStuckCycles: slot.fastStuckCycles,
            });
            slot.lastSweepAttemptAt = Date.now();
            this.tryBridgeReset(slot.spec);
          }
          this.killSlotChildHard(slot);
          continue;
        }

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
    // After per-slot processing, do peer-relative slow detection.
    this.detectAndRecoverSlowSlots(now);
  }

  /**
   * Auto-detect "slow" readers: ones producing reads, but at a rate
   * significantly below their peers in this agent's location. Without
   * intervention these end up flagged "slow" in Hardware Config and
   * operators have to babysit them. Here the supervisor triggers sweep
   * recovery + bridge reset for any slow slot, fully autonomously.
   *
   * Single-antenna slots only. Mux readers (.16-style) have inherently
   * bursty per-antenna rates and would generate false positives.
   */
  private detectAndRecoverSlowSlots(now: number): void {
    // Gather candidates, grouped by device_type. Different reader roles have
    // fundamentally different natural read rates:
    //   - fixed_reader: scans aisle inventory continuously, sees hundreds of
    //     EPCs in coverage
    //   - transaction_reader: POS / checkout, sees a few EPCs per customer
    //   - door_reader: gate/portal, only fires when items cross
    // Lumping them in one peer pool flagged the POS reader and Office-area
    // readers as "slow" even though they were healthy for their role —
    // and worse, triggered bridge resets + binary respawns on them, which
    // is wasted work that briefly interrupts their normal stream. Grouping
    // by device_type means each role only compares against its own kind.
    type Cand = { slot: ReaderSlot; rate: number; records: number };
    const candidatesByType = new Map<string, Cand[]>();
    // Post-spawn warmup grace: a freshly-spawned chip takes 5-15s to start
    // emitting reads (cold-boot of the R2000 inventory state machine). The
    // first-byte usually lands within 2-5s, but tag-reads can lag another
    // 5-10s. Skipping slow-detect for the first 20s after spawn prevents
    // the supervisor from kill+respawning a perfectly-healthy chip that
    // just hasn't finished warming up — which would create a death loop
    // (kill at 5s, respawn, kill again at 5s, etc., never producing reads).
    const WARMUP_GRACE_MS = 20_000;
    for (const slot of this.slots.values()) {
      if (slot.shuttingDown) continue;
      if (slot.muxAntennaSequence.length >= 2) continue;
      if (slot.testSession !== null) continue;
      if (!slot.child) continue;
      // slot.lastByteAt is set to Date.now() at spawn — use it as a proxy
      // for "process has been alive at least this long." We don't have a
      // dedicated spawnedAt, but lastByteAt is bumped at spawn AND every
      // byte received; either way "now - lastByteAt < WARMUP_GRACE" means
      // we either spawned recently OR have been receiving bytes recently
      // (latter case = healthy, not a slow-detect concern). Skip both.
      if (now - slot.lastByteAt < WARMUP_GRACE_MS) continue;
      const windowAge = now - slot.recordWindowStartAt;
      if (windowAge < SLOW_DETECTION_WINDOW_MS / 2) continue;
      const rate = slot.recordsThisWindow / Math.max(1, windowAge / 1000);
      // Group by (device_type, zone) — same reasoning as the WMS-side
      // hardware-config badge logic. Office-zone fixed_reader and Aisle-zone
      // fixed_reader have fundamentally different natural read rates because
      // they cover different inventory density. Lumping them flags healthy
      // Office readers as "slow" because they read at 5-10% of Aisle rates.
      // Same group-by-zone fix the badge gets.
      const dtZone = `${slot.spec.device_type}|${slot.spec.zone_id ?? "_none"}`;
      const arr = candidatesByType.get(dtZone) ?? [];
      arr.push({ slot, rate, records: slot.recordsThisWindow });
      candidatesByType.set(dtZone, arr);
    }

    const resetAllWindows = () => {
      for (const slot of this.slots.values()) {
        if (now - slot.recordWindowStartAt >= SLOW_DETECTION_WINDOW_MS) {
          slot.recordsThisWindow = 0;
          slot.recordWindowStartAt = now;
        }
      }
    };

    for (const [deviceType, candidates] of candidatesByType.entries()) {
      if (candidates.length < SLOW_MIN_PEERS) {
        // Not enough same-role peers to compare meaningfully. A solo POS
        // reader at the checkout has no benchmark; leave it alone.
        continue;
      }
      // Peer median of record counts within this device_type group.
      const counts = candidates.map((c) => c.records).sort((a, b) => a - b);
      const median =
        counts.length % 2 === 0
          ? (counts[counts.length / 2 - 1]! + counts[counts.length / 2]!) / 2
          : counts[Math.floor(counts.length / 2)]!;
      if (median < SLOW_MIN_PEER_RECORDS) {
        // Whole role-group quiet (night, no traffic). Don't flag anyone.
        continue;
      }
      const threshold = median * SLOW_FRACTION_OF_MEDIAN;
      const healthyThreshold = median * 0.5;
      this.applySlowDetectToGroup(now, candidates, median, threshold, healthyThreshold, deviceType);
    }
    resetAllWindows();
  }

  private applySlowDetectToGroup(
    now: number,
    candidates: { slot: ReaderSlot; rate: number; records: number }[],
    median: number,
    threshold: number,
    healthyThreshold: number,
    _deviceType: string,
  ): void {
    for (const c of candidates) {
      // Self-heal: if the slot is reading at >= 50% of peer median, it has
      // naturally recovered. Clear the wedge counter so a future slow
      // episode starts fresh at Level 1. Also clears the wedgedSinceMs
      // flag so the UI's "needs service" badge disappears.
      if (c.records >= healthyThreshold && c.slot.slowRecoveryAttemptTimes.length > 0) {
        log.info("supervisor: slot self-healed — clearing wedge counter", {
          readerId: c.slot.spec.id,
          readerName: c.slot.spec.name,
          fromLevel: c.slot.wedgeLevel,
          recordsThisWindow: c.records,
          peerMedian: median,
        });
        c.slot.slowRecoveryAttemptTimes = [];
        c.slot.wedgeLevel = 0;
        c.slot.wedgedSinceMs = 0;
        // Clear power suggestion too — the configured power is working,
        // no need to recommend a downgrade.
        c.slot.suggestedPowerDbm = null;
      }

      if (
        c.records < threshold &&
        c.slot.sweepPowerOverrideArg === null &&
        now - c.slot.lastSlowRecoveryAt >= SWEEP_RETRY_COOLDOWN_MS
      ) {
        // Update the rolling attempt log and prune to the wider 10-min window.
        c.slot.slowRecoveryAttemptTimes.push(now);
        c.slot.slowRecoveryAttemptTimes = c.slot.slowRecoveryAttemptTimes
          .filter((t) => now - t <= WEDGE_WINDOW_10MIN_MS);
        const attempts5min = c.slot.slowRecoveryAttemptTimes
          .filter((t) => now - t <= WEDGE_WINDOW_5MIN_MS).length;
        const attempts10min = c.slot.slowRecoveryAttemptTimes.length;

        // Wedge-level state machine. Higher levels = stronger action OR
        // give-up signal. Computed fresh each tick from the rolling counter
        // so transitions are explicit in the log.
        let newLevel: 0 | 1 | 2 | 3 = 1;
        if (attempts10min >= WEDGE_LEVEL_3_COUNT) newLevel = 3;
        else if (attempts5min >= WEDGE_LEVEL_2_COUNT) newLevel = 2;
        const levelChanged = newLevel !== c.slot.wedgeLevel;
        c.slot.wedgeLevel = newLevel;

        // Detect the "saved-default footgun" — operator clicked Save Defaults
        // on /antenna_test with cycleMode=oscillating or tagFocus=true, both
        // of which work fine during the test session (because the test sweep
        // kills+respawns the binary every dwell, so the chip's session state
        // never settles into the deadlock the saved defaults trigger in
        // normal `--infinite` operation). Live evidence 2026-05-12: .15 had
        // `behaviour: {tag_focus:true, cycle_mode:oscillating}` saved by
        // accident → silent in regular mode, fine in sweep mode → days of
        // false "hardware wedged" diagnosis. Auto-recovery now reverts the
        // bad behaviour block as part of slow-detect recovery and logs a
        // clear "reset saved defaults" warning so the operator knows what
        // happened. Wins back the reader immediately AND prevents the same
        // pattern from re-trapping any other reader in the fleet.
        const hostileBehaviour =
          c.slot.spec.antennas.some(
            (a) =>
              a.enabled &&
              (a.behaviour?.tag_focus === true ||
                (a.behaviour?.cycle_mode &&
                  a.behaviour.cycle_mode !== "infinite")),
          );

        const baseInfo = {
          readerId: c.slot.spec.id,
          readerName: c.slot.spec.name,
          host: c.slot.spec.network_address,
          slotRecords: c.records,
          peerMedian: median,
          thresholdRecords: Math.round(threshold),
          wedgeLevel: newLevel,
          attempts5min,
          attempts10min,
          hostileBehaviour,
        };

        if (hostileBehaviour) {
          // Surface this as the likely root cause AND stash a power
          // suggestion equal to the configured value so the UI shows a
          // "try N dBm" pill (we don't know a better number; the issue
          // is the cycle/tagfocus, not the power). This is the agent's
          // way of telling the operator: "your saved defaults caused
          // this — go review the antenna config."
          log.warn(
            "supervisor: hostile saved defaults likely causing slowness — " +
              "cycle_mode or tag_focus on antenna config will silently break " +
              "regular --infinite scanning even though sweep-mode test works",
            baseInfo,
          );
        }

        c.slot.lastSlowRecoveryAt = now;
        c.slot.recordsThisWindow = 0;
        c.slot.recordWindowStartAt = now;

        if (newLevel === 3) {
          // Level 3: chip is wedged below software reach. Stop the recovery
          // loop on this slot — the binary stays running so any natural
          // recovery is visible, but no more bridge resets, no more kill
          // +respawns. The heartbeat will report `chassis_wedged_at` to WMS
          // so Hardware Config surfaces a clear "needs hardware service"
          // badge. Operator gets a one-time signal instead of the
          // supervisor silently retrying forever.
          if (levelChanged) {
            log.error(
              "supervisor: reader hardware-wedged — stopping recovery, signaling WMS",
              baseInfo,
            );
            c.slot.wedgedSinceMs = now;
          }
          // No recovery action taken.
        } else if (newLevel === 2 && now - c.slot.lastDeepRecoveryAt >= DEEP_RECOVERY_COOLDOWN_MS) {
          // Level 2: standard recovery hasn't worked. Run a deep bridge
          // re-init (baud renegotiate + mode-server rewrite + port rewrite
          // + reset) — forces the WIZnet bridge to fully restart its UART
          // and TCP listen state from NVRAM. Throttled by
          // DEEP_RECOVERY_COOLDOWN_MS so we don't deep-recover every tick.
          log.warn("supervisor: slow reader — Level 2 deep recovery (bridge re-init)", baseInfo);
          c.slot.lastDeepRecoveryAt = now;
          this.tryBridgeDeepRecovery(c.slot.spec);
          if (c.slot.child) {
            c.slot.intendedKill = true;
            this.killSlotChildHard(c.slot);
          }
        } else {
          // Level 1: standard recovery — bridge reset + binary kill+respawn.
          log.warn("supervisor: slow reader — Level 1 standard recovery", baseInfo);
          this.tryBridgeReset(c.slot.spec);
          if (c.slot.child) {
            c.slot.intendedKill = true;
            this.killSlotChildHard(c.slot);
          }
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
    this.lastBundle = bundle;

    // Default-paused-readers model: a reader is desired (= spawn a child)
    // only when ONE of these is true:
    //   1. bundle.effective_paused is FALSE — the operator manually un-paused
    //      it from Hardware Config, or the schedule says it's a scan window.
    //   2. activeScanSessionReaders.has(reader.id) — a workflow page
    //      (Transfer Out / Cycle Counts / Print-Commission) has an open
    //      scan-session for this reader. The session-end POST will revert.
    //
    // Previously this filter only checked effective_paused. The new wake-
    // for-workflow path overrides paused state for the duration of the
    // session, then default-paused readers stop scanning the moment the
    // operator commits or navigates away.
    const desiredById = new Map(
      bundle.readers
        .filter(
          (r) =>
            !(r.effective_paused ?? false) ||
            this.activeScanSessionReaders.has(r.id) ||
            this.testWakeReaders.has(r.id),
        )
        .map((r) => [r.id, r] as const),
    );

    // Stop slots for readers no longer in the bundle (or paused).
    // Differentiate between paused (still in bundle, comes back later) and
    // truly deleted (not in bundle at all). Only the deletion path wipes
    // the bridge's NVRAM and removes ARP pins — pausing must preserve
    // bridge config so unpause is instant.
    const bundleReaderIds = new Set(bundle.readers.map((r) => r.id));
    for (const [id, slot] of this.slots) {
      if (!desiredById.has(id)) {
        const trulyDeleted = !bundleReaderIds.has(id);
        log.info("supervisor: reader removed, stopping", {
          readerId: id,
          name: slot.spec.name,
          reason: trulyDeleted ? "deleted_from_wms" : "left_bundle_or_paused",
        });
        const stoppedSpec = slot.spec;
        this.stopSlot(slot);
        this.slots.delete(id);
        this.freeSlotIndex(slot.index);
        // Tell the aggregator to forget any reads still buffered for this
        // reader. Without this, a queue can linger across a WMS-side
        // pause/delete until the agent restarts.
        this.onReaderRemoved?.(id);
        // Deleted readers: wipe the bridge's NVRAM back to DHCP and
        // unpin the kernel ARP entry. Operator deleted the device in
        // WMS — they don't want this bridge's static config or ARP
        // claim lingering on the network. Fire-and-forget; tolerant of
        // a hardware-failed bridge (wiznet-cli returns non-zero, we
        // still unpin so the kernel forgets the stale binding).
        if (trulyDeleted) {
          void this.wipeRemovedBridge(stoppedSpec);
        }
      }
    }

    // Start (or update) slots ONLY for readers in the desired set. Iterating
    // bundle.readers directly here was the bug shipped on 2026-05-03:
    // pause/live-scan-inactive correctly killed children in the loop above,
    // then this loop respawned every reader because it ignored the filter.
    // desiredById already excludes paused readers and (when live_scan is
    // inactive) is empty.
    for (const spec of desiredById.values()) {
      const isMonsoon = !((spec.model ?? "").toLowerCase().includes("zebra"));
      if (!isMonsoon) {
        // Zebra readers are handled by a different driver — out of scope
        // for this supervisor.
        continue;
      }
      // Multi-antenna readers run on the console driver, one antenna at a
      // time, with the supervisor itself rotating antennas on the
      // SUPERVISOR_MUX_INTERVAL_MS schedule. The previous "multi-antenna ⇒
      // stream + --cmux" path was observed to under-utilize antenna 1 on
      // at least one production chassis. The driver selection here MUST
      // match the one in spawnReader (line ~1015) or reconcile and
      // spawnReader will infinite-loop on driver flips.
      const enabledCount = spec.antennas.filter((a) => a.enabled).length;
      // Default to console for single-antenna readers when the saved
      // driver is null/undefined. Live evidence 2026-05-09: .78 was
      // freshly commissioned with monsoon_driver explicitly "console" in
      // the WMS DB, but during a brief post-restart reconcile window the
      // spec arrived with the field unset and the supervisor fell back
      // to "stream" — the stream binary then SIGSEGV'd twice in a row
      // against the single-antenna chassis. Console driver works with
      // any single-antenna SA-2000; stream is only the right choice
      // when explicitly configured.
      const desiredDriver: "stream" | "console" =
        enabledCount >= 2 ? "console" : spec.monsoon_driver === "stream" ? "stream" : "console";
      let existing = this.slots.get(spec.id);

      // Per-reader Hard Reset: WMS stamps reader_recover_requested_at when
      // an admin clicks Hardware Config → Reset. If the stamp is newer
      // than the slot's birth, run the same level of force as the all-reader
      // Hard Reset (which restarts the entire agent process). For one reader
      // that means:
      //   (1) Bridge-side cold reset via `wiznet-cli --reset` — clears any
      //       WIZnet wedge state. The all-reader path gets this implicitly
      //       through the agent restart re-discovering all bridges; we
      //       trigger it explicitly here for a single reader.
      //   (2) Slot tear-down: SIGTERM → 10 s grace → SIGKILL, then
      //       ensureRadioStopped (belt-and-braces RFID_RadioAbortOperation)
      //       to GUARANTEE the chip radio is cold. Same chip-cooldown path
      //       that Stop / Stop All use.
      //   (3) Free the slot index — fresh sweep budget, fresh port
      //       rotation, fresh local stream port for the respawn.
      //   (4) Fall through to the fresh-slot creation block below for
      //       respawn with clean state.
      // Wedge counters and power suggestions are also cleared so the slot
      // starts grading itself from zero.
      const resetStampMs = spec.reader_recover_requested_at
        ? new Date(spec.reader_recover_requested_at).getTime()
        : 0;
      if (existing && resetStampMs > existing.slotCreatedAt) {
        log.info("supervisor: hard-reset requested — bridge reset + tear down + respawn", {
          readerId: spec.id,
          readerName: spec.name,
          requestedAt: spec.reader_recover_requested_at,
          slotAgeMs: Date.now() - existing.slotCreatedAt,
        });
        this.tryBridgeReset(spec);
        this.stopSlot(existing);
        this.slots.delete(spec.id);
        this.freeSlotIndex(existing.index);
        existing = undefined;
      }

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
          if (existing.child && !existing.shuttingDown) this.killSlotChildHard(existing);
          continue;
        }
        // Spawn-arg fingerprint: any change to power / read_time / cycle /
        // tag_focus that would alter the binary's CLI requires a respawn,
        // otherwise the running child keeps the stale args until something
        // else triggers a restart. Without this, operator edits in
        // Hardware Config silently take effect "eventually" (next crash,
        // next hard reset). Observed 2026-05-12 with .225 read_time_ms
        // bumped 1000 → 2000 in WMS — the running binary kept --read_time
        // 1000 indefinitely.
        const spawnFp = (s: AgentConfigReader): string => {
          const enabled = s.antennas.filter((a) => a.enabled);
          const power = Math.round(
            enabled.length === 0
              ? 0
              : enabled.reduce((sum, a) => sum + a.transmit_power_dbm, 0) / enabled.length,
          );
          const stamp = enabled[0];
          const beh = stamp?.behaviour;
          return [
            power,
            beh?.read_time_ms ?? 1000,
            beh?.cycle_mode ?? "infinite",
            beh?.tag_focus ? "1" : "0",
            enabled.map((a) => a.antenna_number).sort((x, y) => x - y).join(","),
          ].join("|");
        };
        const priorFp = spawnFp(existing.spec);
        const nextFp = spawnFp(spec);
        if (priorFp !== nextFp) {
          log.info("supervisor: spawn-arg change detected, restarting reader", {
            readerId: spec.id,
            readerName: spec.name,
            from: priorFp,
            to: nextFp,
          });
          existing.spec = spec;
          // Operator edit should always honor configured power on next spawn.
          existing.sweepPowerOverrideArg = null;
          existing.lastSweepAttemptAt = 0;
          existing.bytesSinceSpawn = false;
          existing.consecutiveZeroByteKicks = 0;
          if (existing.child && !existing.shuttingDown) this.killSlotChildHard(existing);
          continue;
        }
        // Update the stored spec so any later ops see fresh power/antennas/etc.
        existing.spec = spec;
        // If subprocess is dead, restart cycle will pick it up.
        continue;
      }
      const idx = this.allocateSlotIndex();
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
        consecutiveFastCleanExits: 0,
        fastStuckCycles: 0,
        lastExhaustionResetAt: 0,
        lastRecordAt: 0,
        lastOfflinePushAt: 0,
        lastReportedOnline: false,
        currentDriver: desiredDriver,
        consoleParserState: newConsoleParserState(),
        consoleStampAntenna: enabledForStamp?.antenna_number ?? 1,
        testSession: null,
        intendedKill: false,
        sweepPowerOverrideArg: null,
        lastSweepAttemptAt: 0,
        sweepStepStartedAt: 0,
        muxAntennaSequence: spec.antennas
          .filter((a) => a.enabled)
          .map((a) => a.antenna_number)
          .sort((a, b) => a - b),
        muxCurrentIdx: 0,
        muxSwapAtMs: Date.now() + SUPERVISOR_MUX_INTERVAL_MS,
        slotCreatedAt: Date.now(),
        pendingAbortTimer: null,
        // Initialize to "now" so a freshly-created slot's first 0-byte
        // exit can't fire an abort. Agent restart inherits 5+ zombie
        // child processes that exit SIGKILL/0-byte simultaneously — with
        // `lastAbortAt = 0` every slot's "first" abort would fire and
        // re-wedge the chip across the fleet. Observed 2026-05-12 after
        // a Hard Reset cascade.
        lastAbortAt: Date.now(),
        recordsThisWindow: 0,
        recordWindowStartAt: Date.now(),
        lastSlowRecoveryAt: 0,
        slowRecoveryAttemptTimes: [],
        wedgeLevel: 0,
        wedgedSinceMs: 0,
        lastDeepRecoveryAt: 0,
        bridgeResetAt: 0,
        chipResetAt: 0,
        suggestedPowerDbm: null,
        lastForcedRespawnAt: 0,
        lastUpwardProbeAt: 0,
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
    let slot = this.slots.get(spec.readerId);
    // Wake-for-test path: when a paused reader has no slot (paused readers
    // are filtered out of reconcile), open one for the duration of the
    // test. Without this, "Antenna Test" in the WMS silently no-op'd on
    // any reader whose effective_paused was true — the WMS still showed
    // green/ready, but no tags were ever read. Live repro 2026-05-21 on
    // the POS reader. leaveTestMode() drops testWakeReaders and re-
    // reconciles so the slot stops cleanly once the test ends.
    if (!slot) {
      const inBundle = this.lastBundle?.readers.find((r) => r.id === spec.readerId);
      if (!inBundle) {
        log.warn("supervisor: enterTestMode for reader not in bundle", { readerId: spec.readerId });
        return;
      }
      log.info("supervisor: enterTestMode waking paused reader for antenna test", {
        readerId: spec.readerId,
        readerName: inBundle.name,
        sessionId: spec.sessionId,
      });
      this.testWakeReaders.add(spec.readerId);
      this.reconcile(this.lastBundle!);
      slot = this.slots.get(spec.readerId);
      if (!slot) {
        log.warn("supervisor: enterTestMode could not start slot after wake", { readerId: spec.readerId });
        this.testWakeReaders.delete(spec.readerId);
        return;
      }
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
    // Clear any leftover auto-sweep state from before this test session.
    // Without this, the supervisor's watchdog keeps advancing sweep steps
    // in the background while the test runs (observed 2026-05-12: test
    // session at 33 dBm was being undermined by stale sweep state walking
    // through 310 → 290 → 270 in parallel). The test owns the slot now.
    slot.sweepPowerOverrideArg = null;
    slot.sweepStepStartedAt = 0;
    log.info("supervisor: enterTestMode — killing child to respawn under test flags", {
      readerId: spec.readerId,
      sessionId: spec.sessionId,
    });
    if (slot.child && !slot.shuttingDown) {
      slot.intendedKill = true;
      this.killSlotChildHard(slot);
    }
  }

  /** Leave TEST_MODE for the given reader; the on-exit respawn picks up
   *  the normal flags via the regular spawn path. */
  leaveTestMode(readerId: string): void {
    const slot = this.slots.get(readerId);
    if (!slot) return;
    if (!slot.testSession) return;
    log.info("supervisor: leaveTestMode — reverting to normal scan", { readerId });
    slot.testSession = null;
    if (slot.child && !slot.shuttingDown) {
      slot.intendedKill = true;
      // GRACEFUL SHUTDOWN 2026-05-12: was killSlotChildHard (SIGKILL).
      // SIGKILL leaves the chip mid-inventory, and the next normal-mode
      // spawn connects to a chip that's still in the middle of its
      // previous inventory cycle. The new binary's startup-abort tries
      // to abort an inventory that no longer has a client → chip
      // returns an unexpected response → new binary exits cleanly in
      // ~1 s with 0 reads → respawn loop forever (the exact "reader
      // goes amber after test ends" symptom). Live 2026-05-12 on .69.
      //
      // Fix: SIGTERM first. The new_monsoonreader binary's signal
      // handler issues a graceful "Cancelling read... Cancel confirmed"
      // to the chip BEFORE exiting — leaving the chip in a clean idle
      // state. Then the next normal-mode spawn connects to a clean
      // chip and inventory resumes normally. SIGKILL as a 2-s fallback
      // for the rare case the binary ignores SIGTERM (see
      // killSlotChildHard comment about wiznet-cli / kernel UDP loops).
      const pid = slot.child.pid;
      if (pid) {
        try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
        const child = slot.child;
        setTimeout(() => {
          if (child === slot.child && child.exitCode === null) {
            this.killSlotChildHard(slot);
          }
        }, 2_000);
      } else {
        this.killSlotChildHard(slot);
      }
    }
    // No ensureRadioStopped call here — the SIGTERM'd binary's own
    // shutdown handler sends the chip cleanup. An additional abort
    // would race the next spawn and put the chip back into the wedge.

    // Wake-for-test housekeeping: if enterTestMode opened the slot
    // specifically for this test (paused reader), drop the wake and
    // re-reconcile so the supervisor tears the slot back down. A 2 s
    // delay lets the SIGTERM'd binary finish its shutdown handshake
    // before the slot disappears.
    if (this.testWakeReaders.delete(readerId) && this.lastBundle) {
      const lastBundle = this.lastBundle;
      setTimeout(() => {
        if (this.lastBundle === lastBundle) this.reconcile(lastBundle);
      }, 2_000);
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
    this.usedIndexes.clear();
  }

  private avgPower(spec: AgentConfigReader): number {
    const enabled = spec.antennas.filter((a) => a.enabled);
    if (enabled.length === 0) return 30;
    return enabled.reduce((s, a) => s + a.transmit_power_dbm, 0) / enabled.length;
  }

  private spawnReader(slot: ReaderSlot): void {
    if (slot.shuttingDown) return;
    // If a prior stopSlot scheduled an 11-s ensureRadioStopped that hasn't
    // fired yet, cancel it now — we're about to put a fresh inventory
    // process on this slot's chip, and that stale abort would sabotage
    // the new binary's inventory (fleet-wide silent-respawn bug observed
    // 2026-05-11). See pendingAbortTimer comment on ReaderSlot.
    if (slot.pendingAbortTimer) {
      clearTimeout(slot.pendingAbortTimer);
      slot.pendingAbortTimer = null;
      log.info("supervisor: cancelled pending stale abort before respawn", {
        readerId: slot.spec.id,
        readerName: slot.spec.name,
      });
    }
    // TEST_MODE forces the console driver — the stream binary's bursty
    // alive-but-stuck behaviour would defeat the live-feedback UX of the
    // /antenna-test page. The new_monsoonreader is on the VM regardless
    // of the reader's saved monsoon_driver.
    //
    // Multi-antenna readers (≥2 enabled antennas) ALSO force console driver
    // now, but for a different reason: the supervisor itself rotates
    // antennas (see SUPERVISOR_MUX_INTERVAL_MS comment) by spawning a
    // single-antenna console child per antenna. Chassis-side --cmux mode
    // was observed to under-utilize antenna 1 on at least one production
    // unit (.16 Transfer Bin: 1811 reads on antenna 2, 0 on antenna 1).
    // Supervisor mux gives both antennas full chassis throughput in turn.
    // Mirror the reconcile-path default: console wins unless the saved
    // driver is explicitly "stream". See note at the reconcile site.
    const desired: "stream" | "console" =
      slot.testSession !== null
        ? "console"
        : slot.muxAntennaSequence.length >= 2
          ? "console"
          : slot.spec.monsoon_driver === "stream"
            ? "stream"
            : "console";
    slot.currentDriver = desired;
    if (desired === "console") {
      this.spawnReaderConsole(slot);
      return;
    }
    const { spec } = slot;
    // Multi-antenna mux mode: cap power at 30 dBm. Live-tested 2026-05-07
    // against Transfer Bin (.16): at 30 dBm BOTH antennas read healthy
    // (3151 + 4080 tags in 30s mux_test). At 33 dBm both fail with MAC
    // error 316 (chip's regulatory/thermal backoff). The asymmetric
    // dashboard pattern — ant#2 climbing, ant#1 stuck at 0 — was the
    // chip cycling in/out of the 33 dBm backoff state and port 1
    // happening to recover slower. 30 dBm avoids the backoff entirely.
    // Single-antenna readers continue at the WMS-saved power (typically
    // 33 dBm, verified safe on .18 / .22 / .77 / etc).
    const muxMode = spec.antennas.filter((a) => a.enabled).length >= 2;
    const requestedPower = Math.round(this.avgPower(spec) * 10);
    // Sweep override (when set by the auto-recovery state machine) wins over
    // the configured power. Mux clamp still applies on top.
    const basePower = slot.sweepPowerOverrideArg ?? requestedPower;
    const powerArg = muxMode ? Math.min(basePower, 300) : basePower;

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
    // Antenna selection. Three modes, bench-tested live against .16 on
    // 2026-05-07:
    //   1. Single antenna #1: no flag (binary default)
    //   2. Single antenna #N (N>1): `-a N`
    //   3. Multi-antenna: `--cmux --mxa N1,N2,... --mux_cycles -1`. CRITICAL:
    //      `--infinite` is INCOMPATIBLE with mux mode — combo produces zero
    //      stream bytes (see prior 78a5700 regression). Use `--mux_cycles -1`
    //      for infinite mux cycling instead. Bench: 25-second capture of
    //      this combo against .16 produced 130 valid records correctly
    //      stamped per antenna (byte 9 of the 50-byte stream record).
    //      Binary occasionally crashes with a boost-thread error during
    //      cleanup; supervisor's on-exit respawn handles it.
    const enabledAntennas = spec.antennas.filter((a) => a.enabled);
    const antennaArgs: string[] = [];
    const useMux = enabledAntennas.length >= 2;
    if (useMux) {
      antennaArgs.push(
        "--cmux",
        "--mxa",
        enabledAntennas.map((a) => a.antenna_number).join(","),
        "--mux_cycles",
        "-1",
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
      // Single-antenna readers: `--infinite` cycles continuously. Multi-
      // antenna readers omit `--infinite` and use `--mux_cycles -1` (set
      // above) instead — combining the two flags produces zero stream
      // output (verified live 2026-05-07 with the .16 chassis).
      ...(useMux ? [] : ["--infinite"]),
    ];
    log.info("supervisor: spawning MonsoonReader", {
      readerId: spec.id,
      readerName: spec.name,
      antennas: enabledAntennas.map((a) => a.antenna_number),
      mode: useMux
        ? `mux:${enabledAntennas.map((a) => a.antenna_number).join(",")}`
        : enabledAntennas.length === 1
          ? `single:${enabledAntennas[0]!.antenna_number}`
          : "default:1",
      power: powerArg,
      serialPort,
    });

    // detached:true puts the child in its own process group so the
    // watchdog can SIGKILL the whole group on rotation/silence kicks.
    // Without it, kill("SIGTERM") only signals the immediate child and
    // the binary's main loop reliably ignores SIGTERM — leading to
    // multi-minute orphans pinning 99% CPU on the wrong port. Live
    // evidence 2026-05-07 with the .84 chassis showed exactly this.
    const child = spawn(this.binaries.stream, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/opt/legacy-rfid/runtime",
      detached: true,
    });
    slot.child = child;

    // Grace window for startup — without this the watchdog would kick a
    // freshly-spawned MonsoonReader before its stream socket has even
    // produced its first byte.
    slot.lastByteAt = Date.now();

    // Drain stdout (legacy stream binary doesn't print useful info on it).
    // Capture stderr though — when the WIZnet bridge's UART buffer holds
    // partial Impinj-MAC reply bytes from a prior abrupt kill, the binary
    // prints framing-corruption errors like "Socket out of sync, got
    // wrong access_flag 1" and exits clean with zero records. These
    // were silently dropped historically; surface as warn so the
    // bridge-buffer issue is visible in the journal.
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf8").trim();
      if (!msg) return;
      if (/out of sync|wrong access_flag|access_flag/i.test(msg)) {
        log.warn("supervisor: stream binary framing error (bridge UART buffer likely stale)", {
          readerId: spec.id,
          msg: msg.slice(0, 240),
        });
      } else {
        log.debug("supervisor: stream binary stderr", {
          readerId: spec.id,
          msg: msg.slice(0, 240),
        });
      }
    });

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
      //
      // Multi-antenna mux mode: the legacy binary reliably SIGSEGVs after
      // ~1-3 seconds in --cmux mode (boost thread deadlock during the mux
      // cycle's antenna switch). Each crash IS the binary's normal end-of-
      // cycle, not a fault. Bench-tested live 2026-05-07 against .16:
      // 130 valid records produced per ~25s window before SIGSEGV. Treat
      // these crashes like clean exits — no backoff growth, immediate
      // respawn — so throughput approximates `cycle_length / startup_time`
      // instead of decaying toward zero under exponential backoff.
      const cleanExit = code === 0 && !signal;
      // Multi-antenna mux mode reliably crashes with the binary's boost-thread
      // sequence at the antenna switch — observed both SIGSEGV and SIGABRT
      // depending on which thread races first. Treat any signal exit in mux
      // mode as expected (no backoff growth) so the next respawn is fast.
      const expectedMuxCrash = useMux && signal !== null;
      // Supervisor-initiated kill (enterTestMode/leaveTestMode): not a fault,
      // respawn fast. Otherwise the test child shows up 60s after the click,
      // which is well past when the /antenna-test session has already ended.
      const wasIntendedKill = slot.intendedKill;
      slot.intendedKill = false;
      const treatAsClean = cleanExit || expectedMuxCrash || wasIntendedKill;
      // Was 250 ms; reduced 2026-05-12 to shorten antenna-test cold-start.
      // For wasIntendedKill (enterTestMode, leaveTestMode, mux swap) the
      // delay is just to let the OS reap the SIGKILLed child before
      // binding the same local ports; 75 ms is enough on modern kernels.
      const delay = treatAsClean ? 75 : slot.backoffMs;
      if (cleanExit) {
        log.debug("supervisor: MonsoonReader cycle complete, respawning", {
          readerId: spec.id,
        });
      } else if (expectedMuxCrash) {
        log.debug("supervisor: MonsoonReader mux-mode SIGSEGV (expected), respawning", {
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
      // Rapid-respawn pattern (child exits without producing any bytes —
      // typically TCP-refuse from a dead bridge or wrong port): silence
      // watchdog can't fire because each spawn resets `lastByteAt`. Push
      // offline here so the WMS reflects truth. Throttled to ~once/min.
      // Also fire a chip-level radio abort: a 0-byte child often means
      // the chassis is in a wedged Gen2 state from a prior dirty kill,
      // not that the bridge is dead. ensureRadioStopped resets the chip
      // session so the next spawn starts clean. Extend the respawn
      // delay so the abort has time to grab the bridge's single TCP slot.
      //
      // CRITICAL FIX 2026-05-11: previously this fired the abort on
      // EVERY 0-byte exit, which produced an ~5-second-cadence loop of
      // abort → respawn → abort → respawn. Each abort puts the chip in
      // a post-RadioAbortOperation wedge state where the next binary's
      // inventory commands are acked but produce no tag frames. The
      // loop was the bug — not the chip. Now we only fire the abort on
      // the FIRST 0-byte exit of a streak; subsequent 0-byte exits skip
      // the abort and just respawn, giving the chip a chance to actually
      // accept the new binary's inventory commands without being kicked
      // back into wedge state. Counter is reset by any spawn that sees
      // bytes (slot.bytesSinceSpawn = true).
      if (!slot.bytesSinceSpawn) {
        this.pushReaderOfflineIfDue(slot, Date.now());
        // The on-exit 0-byte ensureRadioStopped was REMOVED 2026-05-12.
        // Original intent: "a 0-byte child often means wedged Gen2 state,
        // ensureRadioStopped resets the chip session so the next spawn
        // starts clean." Live data showed the opposite: the abort is
        // exactly what PUTS the chip into the post-RadioAbortOperation
        // wedge state it was trying to fix. The next-spawn binary's own
        // startup-abort handles re-init cleanly; an extra abort between
        // spawns just wedges the chip. Bridge reset (wiznet-cli --reset)
        // is the actual recovery for deeply-wedged chips, not another
        // chip-level abort. Counter increment kept so port-rotation
        // and auto-sweep recovery still work.
        slot.consecutiveZeroByteKicks += 1;
        // Auto-sweep recovery — advance on 0-byte exits 2026-05-12.
        // Previously the watchdog only advanced sweep when silentMs
        // exceeded silenceTimeout (~5s), but on these fast-respawning
        // wedged chips the binary exits in <1s and `lastByteAt` resets
        // on every spawn, so silentMs never reached the threshold.
        // Sweep effectively never advanced past the first step. By
        // advancing here on every 0-byte exit we walk through
        // SWEEP_POWERS rapidly until we find a power that produces
        // bytes — observed live 2026-05-12 on .81 stuck at 330 dBm
        // while operator sweep proved the chip CAN read at lower power.
        if (
          slot.sweepPowerOverrideArg !== null &&
          slot.testSession === null &&
          Date.now() - slot.sweepStepStartedAt >= MIN_SWEEP_DWELL_MS
        ) {
          const idx = SWEEP_POWERS.indexOf(slot.sweepPowerOverrideArg);
          if (idx >= 0 && idx + 1 < SWEEP_POWERS.length) {
            const nextPower = SWEEP_POWERS[idx + 1];
            slot.sweepPowerOverrideArg = nextPower ?? null;
            slot.sweepStepStartedAt = Date.now();
            log.info("supervisor: sweep step silent (0-byte exit) — advancing power", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              prevPower: SWEEP_POWERS[idx],
              nextPower,
            });
          } else {
            log.warn("supervisor: sweep recovery failed — silent at all power steps; triggering bridge reset", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              triedPowers: [...SWEEP_POWERS],
            });
            slot.sweepPowerOverrideArg = null;
            slot.lastSweepAttemptAt = Date.now();
            // See watchdog-path sibling: auto-bridge-reset on full
            // sweep failure. wiznet-cli --reset unsticks chips that
            // power-cycling the inventory loop can't.
            this.tryBridgeReset(slot.spec);
          }
        }
      }
      const baseDelay = !slot.bytesSinceSpawn ? Math.max(delay, 5_000) : delay;
      // If a bridge reset fired recently on this slot, stretch the respawn
      // until POST_BRIDGE_RESET_QUIET_MS has elapsed — gives the bridge +
      // chip time to fully reboot before the supervisor reconnects.
      // Without this the reset is wasted: the new spawn lands on a half-
      // booted bridge, exits 0-byte, and the wedge loop continues. The
      // operator's manual fix (stop agent → wait → start) does exactly
      // this; we just automate it per-slot instead of fleet-wide.
      const minSpawnAt = slot.bridgeResetAt
        ? slot.bridgeResetAt + POST_BRIDGE_RESET_QUIET_MS
        : 0;
      const desiredAt = Date.now() + baseDelay;
      const actualAt = Math.max(desiredAt, minSpawnAt);
      const finalDelay = Math.max(0, actualAt - Date.now());
      // Clearing the sweep override after a quiet window forces the next
      // spawn to use the operator's configured power, not a stale sweep
      // step — observed live the chip recovers on configured power once
      // the bridge has fully come back.
      if (minSpawnAt > 0 && finalDelay >= POST_BRIDGE_RESET_QUIET_MS - 1_000) {
        slot.sweepPowerOverrideArg = null;
        slot.bridgeResetAt = 0;
        log.info("supervisor: post-bridge-reset quiet window — single clean spawn at configured power", {
          readerId: slot.spec.id,
          quietMs: finalDelay,
        });
      }
      setTimeout(() => {
        void this.spawnReader(slot);
      }, finalDelay);
      slot.backoffMs = treatAsClean ? 1000 : Math.min(slot.backoffMs * 2, MAX_BACKOFF_MS);
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
      // Sweep override (set by the auto-recovery state machine) wins over
      // the configured power. Test-mode is unaffected — sweep recovery only
      // runs in normal scan after exhaustion, never during /antenna-test.
      powerArg = slot.sweepPowerOverrideArg ?? Math.round(this.avgPower(spec) * 10);
      const enabled = spec.antennas.filter((a) => a.enabled);
      // Supervisor-managed mux: stamp this spawn with the antenna at the
      // current rotation index. Each spawn drives ONE antenna; the
      // watchdog rotates by killing+respawning on the swap deadline.
      const muxAnt =
        slot.muxAntennaSequence.length >= 2
          ? slot.muxAntennaSequence[slot.muxCurrentIdx]
          : null;
      const stampAnt =
        muxAnt !== undefined && muxAnt !== null
          ? enabled.find((a) => a.antenna_number === muxAnt)
          : enabled[0];
      stampAntenna = stampAnt?.antenna_number ?? muxAnt ?? 1;
      // Per-antenna saved defaults from /antenna_test → "Save as default";
      // fall back to hardcoded normal-scan defaults when none set.
      //
      // SAFETY: tag_focus + non-infinite cycle_mode are INTENTIONALLY ignored
      // in normal scanning. Those settings make sense ONLY in an active
      // antenna-test session (where the operator is watching live and the
      // test sweep kills+respawns the binary every dwell, so the chip's
      // session state never settles into the read-suppressed deadlock
      // they trigger). Saved as persistent production defaults they
      // silently kill `--infinite` mode — the reader looks slow / silent
      // even though the chip is fine. Live evidence 2026-05-12: .15 had
      // these saved by accident and looked "VSWR-protected" for hours
      // until the actual cause surfaced. Ignoring them here is the
      // belt-and-braces fix that protects every reader fleet-wide
      // regardless of what saved configs leak through Save-Defaults
      // clicks in the future.
      const beh = stampAnt?.behaviour;
      if (beh?.tag_focus === true || (beh?.cycle_mode && beh.cycle_mode !== "infinite")) {
        log.warn("supervisor: ignoring hostile saved defaults on antenna — using infinite + no tagfocus", {
          readerId: spec.id,
          readerName: spec.name,
          antennaNumber: stampAntenna,
          savedCycleMode: beh.cycle_mode,
          savedTagFocus: beh.tag_focus === true,
        });
      }
      cycleMode = "infinite";
      // 1000ms inventory cycle. Earlier we ran 200ms for "smoother UI
      // ticks," but live evidence on .224 (2026-05-07) showed the chip
      // can't reliably enumerate at 200ms — binary exits clean with zero
      // records every ~700ms in a tight respawn loop. TEST_MODE has
      // always used 1000ms and produces records reliably (985 records in
      // an 11-second window during a manual antenna test). The
      // aggregator's 250ms flush still gives smooth UI cadence because
      // a 1000ms inventory burst still emits records continuously
      // through the burst — the operator perceives smooth ticking.
      readTimeMs = beh?.read_time_ms ?? 1000;
      tagFocus = false; // Belt-and-braces — see SAFETY comment above.
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
    // Reset forced-respawn timer so the next interval counts from THIS spawn.
    slot.lastForcedRespawnAt = 0;

    // Capture spawn time so the on-exit handler can measure how fast the
    // child died. Sub-FAST_CLEAN_EXIT_THRESHOLD_MS cleanExit:true exits
    // accumulate strikes; FAST_CLEAN_EXIT_STRIKES of them in a row trigger
    // an immediate bridge reset, inside the 15-s recovery SLO.
    const spawnStartedAt = Date.now();

    // See spawnReader's stream-binary spawn: detached:true gives the
    // watchdog a process-group handle to SIGKILL on stuck cycles.
    const child = spawn(this.binaries.console, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/opt/legacy-rfid/runtime",
      detached: true,
    });
    slot.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf8").trim();
      if (!msg) return;
      if (/out of sync|wrong access_flag|access_flag/i.test(msg)) {
        log.warn("supervisor: console binary framing error (bridge UART buffer likely stale)", {
          readerId: spec.id,
          msg: msg.slice(0, 240),
        });
      } else {
        log.debug("supervisor: console reader stderr", {
          readerId: spec.id,
          msg: msg.slice(0, 240),
        });
      }
    });

    let totalRecords = 0;
    let totalBad = 0;
    let totalMal = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.length === 0) return;
      slot.lastByteAt = Date.now();
      if (!slot.bytesSinceSpawn) {
        slot.bytesSinceSpawn = true;
        // Auto-sweep diagnosis: bytes arrived at a sub-configured power
        // step. Treat the sweep as purely DIAGNOSTIC (the chip is alive,
        // just wedged at the configured power) — fire a bridge reset,
        // clear the override, and respawn at the operator-configured
        // power. Never pin a recovery power: operator-configured wins.
        //
        // If the chip immediately re-wedges at configured power, the
        // slow-detector will trip again and another sweep will run. The
        // loop is bounded by SWEEP_RETRY_COOLDOWN_MS (60 s) so the
        // journal makes the situation loud (frequent recovery cycles)
        // instead of a silent under-power cap.
        //
        // Gate on supervisor-driven sweep + NORMAL mode so an operator
        // antenna-test run can't be mistaken for a recovery success.
        if (slot.sweepPowerOverrideArg !== null && slot.testSession === null) {
          // Stash the diagnosed working power as a SUGGESTION. The heartbeat
          // pushes it to WMS so Hardware Config can show a one-click "Apply
          // X dBm" banner — operator approves the actual config change.
          // Stored in dBm (the human-facing scale), not the binary's
          // dBm*10 — sweepPowerOverrideArg uses dBm*10, divide.
          const workingDbm = Math.round(slot.sweepPowerOverrideArg / 10);
          const configuredDbm = Math.round(this.avgPower(slot.spec));
          if (workingDbm < configuredDbm) {
            slot.suggestedPowerDbm = workingDbm;
          }
          log.info("supervisor: sweep diagnosed working power — bridge reset + configured retry", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            diagnosedAtPower: slot.sweepPowerOverrideArg,
            configuredPower: Math.round(this.avgPower(slot.spec) * 10),
            suggestionDbm: slot.suggestedPowerDbm,
          });
          this.tryBridgeReset(slot.spec);
          slot.sweepPowerOverrideArg = null;
          slot.lastSweepAttemptAt = Date.now();
          slot.bytesSinceSpawn = false;
          slot.intendedKill = true;
          this.killSlotChildHard(slot);
          return;
        }
        // First byte on this spawn — chassis is reachable. Tell the WMS
        // so the dashboard flips the reader online indicator even if
        // tags aren't currently in the antenna's coverage range. Gated
        // on offline→online transition so back-to-back respawns don't
        // re-push the same state.
        if (!slot.lastReportedOnline) {
          slot.lastReportedOnline = true;
          slot.lastOfflinePushAt = 0;
          try {
            this.onReaderOnline?.(spec.id);
          } catch {
            /* never let a callback exception kill the data pipeline */
          }
        }
      }
      slot.consecutiveZeroByteKicks = 0;

      const result = parseConsoleChunk(chunk.toString("utf8"), slot.consoleParserState);
      totalRecords += result.records.length;
      totalBad += result.badCrcCount;
      totalMal += result.malformedCount;
      if (result.records.length > 0) {
        slot.lastRecordAt = Date.now();
        slot.recordsThisWindow += result.records.length;
      }

      const stamp = new Date().toISOString();
      const ts = slot.testSession;
      const nowMs = Date.now();
      // Cross-antenna dedup window for supervisor-managed mux readers: an
      // EPC sighted on one antenna shouldn't also count under the next
      // antenna in the rotation. Window = the swap interval, so a single
      // EPC counts on at most one antenna per cycle. Non-mux readers keep
      // the existing behaviour (DEDUP_WINDOW_MS = 0, no agent-side dedup,
      // WMS does ingest-time dedup).
      const muxDedupActive = slot.muxAntennaSequence.length >= 2 && !ts;
      for (const rec of result.records) {
        if (muxDedupActive) {
          const last = slot.lastSeen.get(rec.epcHex);
          if (last !== undefined && nowMs - last < SUPERVISOR_MUX_INTERVAL_MS) continue;
          slot.lastSeen.set(rec.epcHex, nowMs);
        }
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
      // Supervisor-initiated kill (enterTestMode/leaveTestMode): not a fault,
      // respawn fast. See ReaderSlot.intendedKill comment for why this
      // matters to the /antenna-test UX.
      const wasIntendedKill = slot.intendedKill;
      slot.intendedKill = false;
      const treatAsClean = cleanExit || wasIntendedKill;
      // Was 250 ms; reduced 2026-05-12 to shorten antenna-test cold-start.
      // For wasIntendedKill (enterTestMode, leaveTestMode, mux swap) the
      // delay is just to let the OS reap the SIGKILLed child before
      // binding the same local ports; 75 ms is enough on modern kernels.
      const delay = treatAsClean ? 75 : slot.backoffMs;
      const spawnDurationMs = Date.now() - spawnStartedAt;
      log.info("supervisor: new_monsoonreader exited", {
        readerId: spec.id,
        code,
        signal,
        totalRecords,
        droppedBadCrc: totalBad,
        malformed: totalMal,
        cleanExit,
        wasIntendedKill,
        spawnDurationMs,
      });
      // FAST-STUCK DETECTION 2026-05-21: track consecutive sub-1s
      // cleanExit:true 0-records exits. After FAST_CLEAN_EXIT_STRIKES
      // in a row, fire tryBridgeReset immediately and kill any in-
      // flight child. Bypasses the silence-watchdog (which never fires
      // on this pattern because each spawn briefly resets the timer)
      // so the 15-s recovery SLO can be met. Reset on any byte received,
      // on a non-clean exit (signal/non-zero code), or on a non-fast
      // exit (the child got past handshake but read nothing — different
      // failure mode handled by the existing watchdog).
      if (
        cleanExit &&
        !wasIntendedKill &&
        !slot.bytesSinceSpawn &&
        totalRecords === 0 &&
        spawnDurationMs < FAST_CLEAN_EXIT_THRESHOLD_MS
      ) {
        slot.consecutiveFastCleanExits += 1;
        if (slot.consecutiveFastCleanExits >= FAST_CLEAN_EXIT_STRIKES) {
          slot.fastStuckCycles += 1;
          // Escalation: after FAST_STUCK_CHIP_RESET_AFTER_CYCLES bridge-only
          // recoveries have failed in a row (chip stayed wedged across
          // multiple bridge reboots), fire ONE chip-level reset opcode at
          // the chip — rate-limited by CHIP_RESET_COOLDOWN_MS so this can
          // never repeat at the every-60s cadence that hurt the chip
          // 2026-05-21 afternoon. Chip-reset is the only software path
          // that can clear an R2000 MCU wedge without a PoE cycle.
          const sinceLastChipReset = Date.now() - slot.chipResetAt;
          const chipResetAllowed =
            slot.fastStuckCycles >= FAST_STUCK_CHIP_RESET_AFTER_CYCLES &&
            sinceLastChipReset >= CHIP_RESET_COOLDOWN_MS;
          if (chipResetAllowed) {
            log.warn("supervisor: bridge-reset cycles exhausted — escalating to chip-level reset", {
              readerId: spec.id,
              readerName: spec.name,
              host: String(spec.network_address ?? ""),
              fastStuckCycles: slot.fastStuckCycles,
              cooldownAgoMs: slot.chipResetAt === 0 ? null : sinceLastChipReset,
            });
            slot.fastStuckCycles = 0;
            slot.chipResetAt = Date.now();
            this.tryChipReset(spec);
          } else {
            log.warn("supervisor: fast-stuck detected — firing immediate bridge reset", {
              readerId: spec.id,
              readerName: spec.name,
              host: String(spec.network_address ?? ""),
              strikes: slot.consecutiveFastCleanExits,
              fastStuckCycles: slot.fastStuckCycles,
              spawnDurationMs,
            });
            this.tryBridgeReset(spec);
          }
          slot.consecutiveFastCleanExits = 0;
        }
      } else if (slot.bytesSinceSpawn || !cleanExit) {
        slot.consecutiveFastCleanExits = 0;
        if (slot.bytesSinceSpawn) slot.fastStuckCycles = 0;
      }
      // Rapid-respawn pattern (cleanExit:true, totalRecords:0, child exited
      // without ever producing a byte) means the chip is silent — typically
      // bridge port mismatch or the chassis isn't running its RFID firmware.
      // Each spawn resets `lastByteAt` so the silence watchdog never fires
      // on this pattern; without an explicit on-exit offline push the WMS
      // would keep showing the reader online indefinitely.
      // Same rationale as the stream-driver branch: a 0-byte child often
      // means a wedged chip Gen2 state, not a dead bridge. Send a radio
      // abort so the next spawn doesn't inherit the lock; extend the
      // respawn delay so the abort has time to grab the bridge.
      //
      // CRITICAL FIX 2026-05-11: only abort on the FIRST 0-byte exit of
      // a streak. Subsequent aborts in a 5-s respawn loop create the
      // exact wedge state they're trying to fix — chip ends up accepting
      // commands but emitting no tag frames forever. See matching change
      // in the stream-driver on-exit branch above.
      if (!slot.bytesSinceSpawn) {
        this.pushReaderOfflineIfDue(slot, Date.now());
        // The on-exit 0-byte ensureRadioStopped was REMOVED 2026-05-12.
        // Original intent: "a 0-byte child often means wedged Gen2 state,
        // ensureRadioStopped resets the chip session so the next spawn
        // starts clean." Live data showed the opposite: the abort is
        // exactly what PUTS the chip into the post-RadioAbortOperation
        // wedge state it was trying to fix. The next-spawn binary's own
        // startup-abort handles re-init cleanly; an extra abort between
        // spawns just wedges the chip. Bridge reset (wiznet-cli --reset)
        // is the actual recovery for deeply-wedged chips, not another
        // chip-level abort. Counter increment kept so port-rotation
        // and auto-sweep recovery still work.
        slot.consecutiveZeroByteKicks += 1;
        // Auto-sweep recovery — advance on 0-byte exits 2026-05-12.
        // Previously the watchdog only advanced sweep when silentMs
        // exceeded silenceTimeout (~5s), but on these fast-respawning
        // wedged chips the binary exits in <1s and `lastByteAt` resets
        // on every spawn, so silentMs never reached the threshold.
        // Sweep effectively never advanced past the first step. By
        // advancing here on every 0-byte exit we walk through
        // SWEEP_POWERS rapidly until we find a power that produces
        // bytes — observed live 2026-05-12 on .81 stuck at 330 dBm
        // while operator sweep proved the chip CAN read at lower power.
        if (
          slot.sweepPowerOverrideArg !== null &&
          slot.testSession === null &&
          Date.now() - slot.sweepStepStartedAt >= MIN_SWEEP_DWELL_MS
        ) {
          const idx = SWEEP_POWERS.indexOf(slot.sweepPowerOverrideArg);
          if (idx >= 0 && idx + 1 < SWEEP_POWERS.length) {
            const nextPower = SWEEP_POWERS[idx + 1];
            slot.sweepPowerOverrideArg = nextPower ?? null;
            slot.sweepStepStartedAt = Date.now();
            log.info("supervisor: sweep step silent (0-byte exit) — advancing power", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              prevPower: SWEEP_POWERS[idx],
              nextPower,
            });
          } else {
            log.warn("supervisor: sweep recovery failed — silent at all power steps; triggering bridge reset", {
              readerId: slot.spec.id,
              readerName: slot.spec.name,
              triedPowers: [...SWEEP_POWERS],
            });
            slot.sweepPowerOverrideArg = null;
            slot.lastSweepAttemptAt = Date.now();
            // See watchdog-path sibling: auto-bridge-reset on full
            // sweep failure. wiznet-cli --reset unsticks chips that
            // power-cycling the inventory loop can't.
            this.tryBridgeReset(slot.spec);
          }
        }
      }
      const baseDelay = !slot.bytesSinceSpawn ? Math.max(delay, 5_000) : delay;
      // If a bridge reset fired recently on this slot, stretch the respawn
      // until POST_BRIDGE_RESET_QUIET_MS has elapsed — gives the bridge +
      // chip time to fully reboot before the supervisor reconnects.
      // Without this the reset is wasted: the new spawn lands on a half-
      // booted bridge, exits 0-byte, and the wedge loop continues. The
      // operator's manual fix (stop agent → wait → start) does exactly
      // this; we just automate it per-slot instead of fleet-wide.
      const minSpawnAt = slot.bridgeResetAt
        ? slot.bridgeResetAt + POST_BRIDGE_RESET_QUIET_MS
        : 0;
      const desiredAt = Date.now() + baseDelay;
      const actualAt = Math.max(desiredAt, minSpawnAt);
      const finalDelay = Math.max(0, actualAt - Date.now());
      // Clearing the sweep override after a quiet window forces the next
      // spawn to use the operator's configured power, not a stale sweep
      // step — observed live the chip recovers on configured power once
      // the bridge has fully come back.
      if (minSpawnAt > 0 && finalDelay >= POST_BRIDGE_RESET_QUIET_MS - 1_000) {
        slot.sweepPowerOverrideArg = null;
        slot.bridgeResetAt = 0;
        log.info("supervisor: post-bridge-reset quiet window — single clean spawn at configured power", {
          readerId: slot.spec.id,
          quietMs: finalDelay,
        });
      }
      setTimeout(() => {
        void this.spawnReader(slot);
      }, finalDelay);
      slot.backoffMs = treatAsClean ? 1000 : Math.min(slot.backoffMs * 2, MAX_BACKOFF_MS);
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
      if (!slot.bytesSinceSpawn) {
        slot.bytesSinceSpawn = true;
        // Auto-sweep recovery succeeded — see comment in console-driver
        // byte-arrival path. Clear the override; next spawn returns to
        // operator-configured power. Auto-sweep is diagnostic only.
        if (slot.sweepPowerOverrideArg !== null) {
          log.info("supervisor: sweep recovery succeeded — chassis producing bytes", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
            recoveredAtPower: slot.sweepPowerOverrideArg,
            note: "clearing override; next spawn uses operator-configured power",
          });
          slot.sweepPowerOverrideArg = null;
          slot.lastSweepAttemptAt = Date.now();
        }
        // Chassis is reachable — tell the WMS the reader is online,
        // even if no tag records have been parsed out of the stream yet.
        // Gated on offline→online transition so back-to-back respawns
        // don't re-push the same state.
        if (!slot.lastReportedOnline) {
          slot.lastReportedOnline = true;
          slot.lastOfflinePushAt = 0;
          try {
            this.onReaderOnline?.(slot.spec.id);
          } catch {
            /* never let a callback exception kill the data pipeline */
          }
        }
      }
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
    if (result.records.length > 0) {
      slot.lastRecordAt = now;
      slot.recordsThisWindow += result.records.length;
    }
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
    // If a prior stopSlot already scheduled an abort that hasn't fired
    // yet, drop it — we only want at most one pending belt-and-braces
    // abort per slot, and the latest stop's intent supersedes any prior.
    if (slot.pendingAbortTimer) {
      clearTimeout(slot.pendingAbortTimer);
      slot.pendingAbortTimer = null;
    }
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
      //
      // CRITICAL: we store the handle on the slot so that if a fresh
      // child gets spawned for this slot within 11 s (Stop-all + Start-all
      // race, or a scan-session wake right after a transient stop), the
      // spawn path can cancel this stale abort before it slams the live
      // chip and silently aborts the new inventory. The fleet-wide silent-
      // respawn loop observed 2026-05-11 was this exact race.
      slot.pendingAbortTimer = setTimeout(() => {
        slot.pendingAbortTimer = null;
        // Last-ditch self-check: don't abort if a fresh child is alive on
        // the slot right now. Belt-and-braces on the belt-and-braces.
        if (slot.child && slot.child.exitCode === null && !slot.shuttingDown) {
          log.info("supervisor: skipping stale ensureRadioStopped — slot has live child", {
            readerId: slot.spec.id,
            readerName: slot.spec.name,
          });
          return;
        }
        this.ensureRadioStopped(slot.spec);
      }, 11_000);
    }
  }

  /**
   * Spawn the legacy MonsoonReader briefly against the given reader, give
   * it 4 s for its startup abort sequence to land, then kill cleanly.
   * The binary's first action on connect is RFID_RadioAbortOperation —
   * which is exactly what we want. Tolerant of failure (segfault on the
   * binary itself, network unreach, etc.) — radio stays at whatever
   * state it was in before, which is the same as before this call.
   *
   * The local TCP `--stream` / `--control` ports were previously hardcoded
   * to 39999/29999. With Stop-All firing 11 stopSlot calls within ~30 ms,
   * eleven parallel ensureRadioStopped binaries spawn ~11 s later and all
   * try to bind the same pair — at most one wins, the rest bail out
   * before sending the radio abort. Use `ensureRadioPortBase + counter`
   * so every concurrent abort gets its own port pair.
   */
  /**
   * Trigger a WIZnet bridge reset for the reader via `wiznet-cli --reset`.
   * Used as the last-resort recovery after sweep fails at every power
   * step. Empirically the bridge reset is what unsticks chips that
   * software-level power cycling can't — verified against .15 / .77 /
   * .78 / .81 / .82 / .225 on 2026-05-12.
   *
   * Fire-and-forget: tolerant of failure (missing MAC, missing binary,
   * sudo prompt, etc.). The next sweep retry (60 s later) will run and
   * usually succeed because the bridge has been reset.
   *
   * MAC resolution: prefers `spec.mac_address` from the WMS bundle
   * (kept in sync by the agent's own LAN discovery); falls back to
   * `ip neigh show IP` if the bundle didn't include it.
   */
  /**
   * Deep bridge recovery (Level 2 escalation): sequentially issues
   * `--baud 115200`, `--mode-server`, `--port 10002`, then `--reset`. Each
   * step forces the WIZnet bridge to re-initialize a different layer of its
   * state machine (UART driver, TCP listen mode, listener port, full restart).
   * Empirically clears bridge-wedge states that simple `--reset` alone
   * doesn't fix.
   *
   * Fire-and-forget; each step has an 8s hard timeout via `timeout(1)` to
   * prevent zombie wiznet-cli processes (which were pinning the agent VM
   * load average to 10+ before the timeout was added).
   */
  private tryBridgeDeepRecovery(spec: AgentConfigReader): void {
    const host = String(spec.network_address ?? "");
    if (!host) return;
    const macFromSpec = (spec.mac_address ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
    if (macFromSpec.length !== 12) {
      log.warn("supervisor: tryBridgeDeepRecovery — no MAC, skipping", {
        readerId: spec.id, host,
      });
      return;
    }
    log.info("supervisor: tryBridgeDeepRecovery — baud/mode/port/reset", {
      readerId: spec.id, readerName: spec.name, host, mac: macFromSpec,
    });
    const args = [
      ["--baud", "115200"],
      ["--mode-server"],
      ["--port", "10002"],
      ["--reset"],
    ];
    // Sequential one-shots via setTimeout so each step has time to settle
    // before the next. Total wall time: ~16s. Each child has its own 8s
    // timeout safety net.
    args.forEach((extra, i) => {
      setTimeout(() => {
        try {
          const child = spawn(
            "sudo",
            ["timeout", "--kill-after=1s", "8s", "/opt/legacy-rfid/wiznet-cli", "--ipconfig", macFromSpec, ...extra],
            // detached:false — see tryBridgeReset comment.
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          child.stdout?.resume();
          child.stderr?.resume();
          const killTimer = setTimeout(() => {
            if (child.exitCode === null) {
              try { child.kill("SIGKILL"); } catch { /* already gone */ }
            }
          }, 10_000);
          child.on("exit", (code) => {
            clearTimeout(killTimer);
            log.info("tryBridgeDeepRecovery: step exited", {
              readerId: spec.id, step: extra.join(" "), code,
            });
          });
          child.on("error", () => clearTimeout(killTimer));
        } catch (e) {
          log.warn("tryBridgeDeepRecovery: spawn threw", {
            readerId: spec.id, step: extra.join(" "),
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }, i * 4_000);
    });
  }

  /**
   * Snapshot of slots that the supervisor has flagged at wedge Level 3 —
   * chip is below software-reach, recovery loop is stopped. Heartbeat code
   * reads this to push `chassis_wedged_at` to WMS so the operator UI can
   * surface "needs hardware service" instead of the supervisor silently
   * looping forever.
   */
  getWedgedReaders(): { readerId: string; wedgedSinceMs: number }[] {
    const out: { readerId: string; wedgedSinceMs: number }[] = [];
    for (const slot of this.slots.values()) {
      if (slot.wedgeLevel === 3 && slot.wedgedSinceMs > 0) {
        out.push({ readerId: slot.spec.id, wedgedSinceMs: slot.wedgedSinceMs });
      }
    }
    return out;
  }

  /**
   * Snapshot of slots where the supervisor's auto-sweep found a working
   * power below the operator-configured value. Each entry is one suggestion
   * the heartbeat pushes to WMS so Hardware Config can offer a one-click
   * "Apply X dBm" action. Cleared once the slot self-heals at configured
   * power (chip naturally recovered, no downgrade needed).
   */
  getPowerSuggestions(): { readerId: string; suggestedDbm: number }[] {
    const out: { readerId: string; suggestedDbm: number }[] = [];
    for (const slot of this.slots.values()) {
      if (slot.suggestedPowerDbm !== null) {
        out.push({ readerId: slot.spec.id, suggestedDbm: slot.suggestedPowerDbm });
      }
    }
    return out;
  }

  /**
   * Fire-and-forget cleanup for a reader that was deleted in WMS.
   * Wipes the bridge's NVRAM back to DHCP+SERVER+10002 so the unit is
   * ready for re-deployment (or, if the operator unplugs it, doesn't
   * leak a stale static IP onto a fresh LAN it gets moved to). Also
   * removes the kernel ARP pin for the reader's old IP so the pin
   * daemon doesn't keep refreshing a now-invalid binding.
   *
   * Tolerant of every failure mode: bridge unreachable, MAC missing,
   * sudo unavailable. The deletion completes either way — this is a
   * best-effort hygiene step, not a precondition.
   */
  private async wipeRemovedBridge(spec: AgentConfigReader): Promise<void> {
    const ip = String(spec.network_address ?? "");
    const macRaw = (spec.mac_address ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
    log.info("supervisor: wiping bridge for deleted reader", {
      readerId: spec.id,
      name: spec.name,
      ip,
      mac: macRaw || "(unknown)",
    });
    if (macRaw.length === 12) {
      try {
        const ok = await wipeBridgeToDhcp(macRaw, ip);
        log.info("supervisor: bridge wipe complete", { readerId: spec.id, ok });
      } catch (e) {
        log.warn("supervisor: bridge wipe threw", {
          readerId: spec.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      log.warn("supervisor: bridge wipe skipped — no MAC on spec", { readerId: spec.id, ip });
    }
    if (ip) {
      // Remove the kernel ARP pin. pin-wiznet-readers-arp.service installs
      // these as `nud permanent` — they don't time out. If we leave it,
      // the IP keeps resolving to the deleted bridge's MAC even after
      // a swap/replug. Use the host's `ip` command (no sudo required for
      // delete on Linux when running as root — agent runs as shopcarbon
      // which has passwordless sudo for everything per the VM setup).
      await new Promise<void>((resolve) => {
        const child = spawn(
          "sudo",
          ["-n", "ip", "neigh", "del", ip, "dev", "enp0s3"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* gone */ }
          resolve();
        }, 3_000);
        child.on("exit", (code) => {
          clearTimeout(t);
          log.info("supervisor: arp unpin", { readerId: spec.id, ip, code });
          resolve();
        });
        child.on("error", (e) => {
          clearTimeout(t);
          log.warn("supervisor: arp unpin spawn error", {
            readerId: spec.id,
            ip,
            err: e.message,
          });
          resolve();
        });
      });
    }
  }

  /**
   * Chip-level reset via `new_monsoonreader --reset`. Sends the R2000
   * reset opcode over the bridge's UART to clear the chip's MCU state
   * (selection target, session, inventory queue, and — critically — the
   * UART break loop documented for reader .82 and observed on POS 2026-
   * 05-21).
   *
   * Strict rate-limit: caller (the fast-stuck escalation in the on-exit
   * handler) only calls this after FAST_STUCK_CHIP_RESET_AFTER_CYCLES
   * bridge-reset cycles have failed in a row AND at least
   * CHIP_RESET_COOLDOWN_MS has elapsed since the last chip-reset. The
   * every-60s cadence the prior agent shipped (f8b3ac7) hurt the chip
   * because it kept firing while the chip was mid-recovery; this gating
   * ensures we only fire when bridge-side recovery has demonstrably
   * failed and gives the chip 30 min before any retry.
   */
  private tryChipReset(spec: AgentConfigReader): void {
    const host = String(spec.network_address ?? "");
    if (!host) return;
    const monsoonPort = String(Number(spec.monsoon_serial_port ?? 10002));
    log.warn("supervisor: tryChipReset — chip recovery sequence", {
      readerId: spec.id,
      readerName: spec.name,
      host,
      port: monsoonPort,
    });
    // Sequence: --buffer-reset (clears the chip's internal byte buffers,
    // observed live 2026-05-21 night to actually transition chip state on
    // POS .9), then --reset (R2000 protocol reset opcode), then a bridge
    // reset so the bridge's UART channel is clean for the post-reset
    // session. Spawn each one detached / fire-and-forget so we don't block
    // the supervisor's event loop on a binary that hangs.
    const fireFlag = (flag: string, timeoutSec: string, label: string): void => {
      try {
        const child = spawn(
          "sudo",
          [
            "timeout",
            "--kill-after=1s",
            timeoutSec,
            "/opt/legacy-rfid/new_monsoonreader",
            host,
            monsoonPort,
            flag,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout?.resume();
        child.stderr?.resume();
        child.on("exit", (code) => {
          log.info(`supervisor: tryChipReset — ${label} exited`, { readerId: spec.id, host, code });
        });
        child.on("error", (e) => {
          log.warn(`supervisor: tryChipReset — ${label} spawn error`, {
            readerId: spec.id,
            host,
            err: e.message,
          });
        });
      } catch (e) {
        log.warn(`supervisor: tryChipReset — ${label} threw`, {
          readerId: spec.id,
          host,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    };
    fireFlag("--buffer-reset", "6s", "buffer-reset");
    fireFlag("--reset", "8s", "reset");
    this.tryBridgeReset(spec);
  }

  private tryBridgeReset(spec: AgentConfigReader): void {
    const host = String(spec.network_address ?? "");
    if (!host) return;

    // Stamp the bridge-reset timestamp on the slot (if any) so the on-exit
    // respawn timer can enforce POST_BRIDGE_RESET_QUIET_MS. Without this
    // the supervisor races the reset and lands its next spawn on a half-
    // booted bridge / mid-reset chip — exactly the loop the reset is
    // trying to break.
    const slotForStamp = this.slots.get(spec.id);
    if (slotForStamp) slotForStamp.bridgeResetAt = Date.now();

    // REVERTED 2026-05-21 night: the previous agent (c866c6c and f8b3ac7,
    // 16:51 + 17:01) added concurrent `MonsoonReader --stop` and
    // `new_monsoonreader --reset` to every bridge-reset cycle. Both fired
    // every 60s of silence. The chip-level --reset opcode going to the
    // chip while wiznet-cli was simultaneously rebooting the bridge
    // appears to push the chip's MCU into the UART break loop
    // (`00 00 FF FF FF FF FF FF` reply) that this session has been
    // chasing. At 14:12 (before those commits) the POS reader was
    // reading 4 tags fine at 17 dBm. Reverting to the pre-c866c6c
    // behavior: bridge reset only via wiznet-cli, no chip-side opcodes.
    // If a future genuine "ghost session" case needs `MonsoonReader --stop`
    // again, gate it on actual evidence (HasClient=Y AND zero bytes for
    // N minutes) rather than firing on every silence kick.
    const runReset = (mac: string): void => {
      log.info("supervisor: tryBridgeReset — spawning wiznet-cli --reset", {
        readerId: spec.id,
        readerName: spec.name,
        host,
        mac,
      });
      try {
        // wiznet-cli has a known bug where the discovery/config UDP cycle
        // sometimes hangs at high CPU after the device ACKs — observed
        // 2026-05-12 with multiple zombie processes pinning the agent VM
        // load average to 10+. Wrap in `timeout 8 ...` so a hung child
        // gets SIGTERM after 8s and SIGKILL at 9s. wiznet-cli normally
        // completes in 2-4s; 8s is generous headroom.
        const child = spawn(
          "sudo",
          ["timeout", "--kill-after=1s", "8s", "/opt/legacy-rfid/wiznet-cli", "--ipconfig", mac, "--reset"],
          // detached:false (default) so the child dies with the agent's
          // process group if systemd restarts us mid-call. detached:true
          // earlier left ~3 stuck wiznet-cli orphans per agent restart
          // (survived the parent death; kill-timer was lost in the dying
          // Node event loop). Agent's startup cleanup also nukes any
          // residual wiznet-cli processes inherited across crashes —
          // belt-and-braces against the same orphan class.
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout?.resume();
        child.stderr?.resume();
        // Belt-and-braces: also SIGKILL the child from the supervisor side
        // after 10s in case `timeout(1)` itself is missing or misbehaves.
        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            log.warn("tryBridgeReset: child still alive after 10s, force-killed", {
              readerId: spec.id, host, mac,
            });
          }
        }, 10_000);
        child.on("exit", (code) => {
          clearTimeout(killTimer);
          log.info("tryBridgeReset: wiznet-cli exited", { readerId: spec.id, host, mac, code });
        });
        child.on("error", (e) => {
          clearTimeout(killTimer);
          log.warn("tryBridgeReset: spawn error", { readerId: spec.id, host, mac, err: e.message });
        });
      } catch (e) {
        log.warn("tryBridgeReset: spawn threw", {
          readerId: spec.id,
          host,
          mac,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    };

    const macFromSpec = (spec.mac_address ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
    if (macFromSpec.length === 12) {
      runReset(macFromSpec);
      return;
    }

    // Fallback: resolve MAC from the kernel ARP table via `ip neigh show IP`.
    // Format: "192.168.1.15 dev wlp2s0 lladdr 00:08:dc:1e:19:80 STALE"
    try {
      const arpProbe = spawn("ip", ["neigh", "show", host], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      arpProbe.stdout?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
      arpProbe.on("exit", () => {
        const m = /lladdr\s+([0-9a-f:]{17})/i.exec(out);
        if (!m) {
          log.warn("tryBridgeReset: no MAC for reader and ARP didn't resolve, skipping", {
            readerId: spec.id,
            host,
          });
          return;
        }
        const mac = m[1]!.replace(/:/g, "").toUpperCase();
        runReset(mac);
      });
    } catch (e) {
      log.warn("tryBridgeReset: arp probe threw", {
        readerId: spec.id,
        host,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private ensureRadioPortCounter = 0;
  private ensureRadioStopped(spec: AgentConfigReader): void {
    const host = String(spec.network_address ?? "");
    if (!host) return;
    const port = Number(spec.monsoon_serial_port ?? 10002);
    // Step the local-binding ports per call so parallel aborts don't
    // collide on bind. 39999/29999 was the original single value; we now
    // use that as the base and bump by a 256-cell ring.
    const offset = this.ensureRadioPortCounter++ & 0xff;
    const localStream = 39999 - offset;
    const localControl = 29999 - offset;
    const args = [
      "--num", "1",
      "--stream", String(localStream),
      "--control", String(localControl),
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
