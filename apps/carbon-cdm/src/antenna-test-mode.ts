import type { AgentEnv } from "./config.js";
import { log } from "./log.js";
import {
  fetchActiveSessions,
  postAntennaTestReads,
  type ActiveAntennaTestSession,
  type ActiveScanSession,
  type AntennaTestIngestRead,
} from "./wms-client.js";

/**
 * Owns the agent-side state for the operator-driven /antenna-test page.
 *
 *   - Polls WMS every POLL_INTERVAL_MS for active sessions at this agent's
 *     location. Cheap: one HTTPS GET, returns `{sessions:[]}` 99 % of the
 *     time when no operator is testing.
 *   - When a session appears: tells the supervisor to enter TEST_MODE for
 *     the matching reader (which preempts the reader's normal scan and
 *     spawns a fresh child with the operator's chosen flags + single
 *     antenna). Other readers untouched.
 *   - When the session disappears (operator clicked Stop / browser closed
 *     long enough that the WMS auto-expired it): tells the supervisor to
 *     leave TEST_MODE and the reader resumes normal reconcile.
 *   - When the session's flags change between polls (operator nudged the
 *     power slider): tells the supervisor to apply the new flags. The
 *     supervisor implements that as a kill+respawn since MonsoonReader
 *     can't live-tune those args.
 *
 *  Reads from a TEST_MODE child are NOT routed through ReadAggregator
 *  (which buffers 1 s for the normal scan path). They go through THIS
 *  module's own micro-batcher: 100 ms or 25 reads, whichever first, so
 *  the operator's UI feels live. We POST to /api/antenna-test/ingest
 *  which the WMS fans out via SSE — does NOT write to cdm_reads.
 */

/** WMS poll cadence — drives BOTH antenna-test session pickup AND
 *  scan-session wake (transfer-out / cycle-count / print-commission). 250 ms
 *  was chosen because the scan-session model defaults readers to PAUSED:
 *  the click-to-first-EPC cold-path cost is dominated by this interval.
 *  At 1 s we measured up to ~8 s cold-path; at 250 ms it's ~2-3 s, with
 *  the remainder being hardware floor (chip mux init + first-tag detect).
 *  Cost: 4× more poll requests, each ~50 ms server-side. Negligible load. */
const POLL_INTERVAL_MS = 250;
/** Micro-batcher: ship reads at least this often. */
const FLUSH_INTERVAL_MS = 100;
/** Micro-batcher: or earlier if we hit this many. */
const FLUSH_AT_BATCH = 25;
/** Per-reader cap on queued reads — drop oldest beyond this if WMS is slow. */
const QUEUE_MAX = 5_000;

export type TestSessionApplied = {
  sessionId: string;
  readerId: string;
  antennaNumber: number;
  flags: ActiveAntennaTestSession["flags"];
};

type SweepRuntime = {
  /** Inclusive lowest power level dBm × 10. */
  startPowerArg: number;
  /** Inclusive highest. */
  endPowerArg: number;
  /** Increment per step. */
  stepPowerArg: number;
  /** ms per step. */
  dwellMs: number;
  /** dBm × 10 the binary is currently spawned at. */
  currentPowerArg: number;
  /** 0-indexed step within the ramp. */
  stepIndex: number;
  /** Total steps in the ramp (so we can render progress). */
  totalSteps: number;
  /** ms-since-epoch the current step started. */
  stepStartedAtMs: number;
  /** True once we've stepped past endPowerArg — agent stops bumping. */
  done: boolean;
};

export type AntennaTestSupervisorHooks = {
  /** Tell the supervisor to enter TEST_MODE for this reader. Must respawn
   *  the reader's child with the test flags + single antenna. Idempotent
   *  on flags-equal calls; on flags-changed calls, must kill+respawn. */
  enterTestMode: (s: TestSessionApplied) => void;
  /** Tell the supervisor to leave TEST_MODE for the reader; normal scan
   *  flags resume on next reconcile cycle. */
  leaveTestMode: (readerId: string) => void;
  /** Update the set of reader IDs that have an ACTIVE workflow scan-session
   *  (Transfer Out / Cycle Counts / Print-Commission). The supervisor's
   *  reconcile treats these readers as un-paused regardless of their
   *  persisted scan_paused_at. Default state in the new model is paused;
   *  this is the only mechanism (besides Hardware Config admin Resume) that
   *  brings a reader to active scan. */
  setActiveScanSessionReaders: (readerIds: Set<string>) => void;
};

type Pending = {
  sessionId: string;
  read: AntennaTestIngestRead;
};

export class AntennaTestController {
  private polling = false;
  private pollHandle: NodeJS.Timeout | null = null;
  private flushHandle: NodeJS.Timeout | null = null;

  /** Sessions we've handed to the supervisor (sessionId → applied). */
  private applied = new Map<string, TestSessionApplied>();

  /** Queue of reads pending POST to /api/antenna-test/ingest. */
  private queue: Pending[] = [];

  /** Per-session running tally for the SSE stats messages. */
  private stats = new Map<
    string,
    { uniqueEpcs: Set<string>; totalReads: number; droppedBadCrc: number }
  >();

  /** Per-session sweep state (only populated when session.sweep is set). */
  private sweep = new Map<string, SweepRuntime>();

  private hooks: AntennaTestSupervisorHooks | null = null;

  constructor(private readonly env: AgentEnv) {}

  /** Set after both controller and supervisor exist (circular ref). */
  attachSupervisorHooks(hooks: AntennaTestSupervisorHooks): void {
    this.hooks = hooks;
  }

  start(): void {
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => this.tickPoll(), POLL_INTERVAL_MS);
    this.flushHandle = setInterval(() => {
      this.tickSweep();
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Fire one poll immediately so a Start-just-clicked operator doesn't
    // wait the full POLL_INTERVAL_MS for the first reconcile.
    void this.tickPoll();
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.flushHandle) clearInterval(this.flushHandle);
    this.pollHandle = null;
    this.flushHandle = null;
    // Tell the supervisor to revert any active test modes so we don't leave
    // a reader pinned to the test child after agent shutdown.
    if (this.hooks) {
      for (const a of this.applied.values()) this.hooks.leaveTestMode(a.readerId);
    }
    this.applied.clear();
    this.queue = [];
    this.stats.clear();
    this.sweep.clear();
  }

  /**
   * Supervisor hands us each tag-read from a TEST_MODE child by calling
   * this. We enqueue for the next 100 ms flush.
   */
  recordRead(
    sessionId: string,
    read: AntennaTestIngestRead,
    droppedBadCrcDelta: number = 0,
  ): void {
    let s = this.stats.get(sessionId);
    if (!s) {
      s = { uniqueEpcs: new Set(), totalReads: 0, droppedBadCrc: 0 };
      this.stats.set(sessionId, s);
    }
    s.uniqueEpcs.add(read.epcHex);
    s.totalReads += 1;
    s.droppedBadCrc += droppedBadCrcDelta;

    this.queue.push({ sessionId, read });
    if (this.queue.length > QUEUE_MAX) {
      const overflow = this.queue.length - QUEUE_MAX;
      this.queue.splice(0, overflow);
      log.warn("antenna-test ingest queue overflow — dropping oldest", { overflow });
    }
    if (this.queue.length >= FLUSH_AT_BATCH) {
      void this.flush();
    }
  }

  // ── poll ─────────────────────────────────────────────────────────────────

  private async tickPoll(): Promise<void> {
    if (this.polling) return; // simple in-flight guard
    this.polling = true;
    try {
      const { antennaTestSessions, scanSessions } = await fetchActiveSessions(this.env);
      this.reconcile(antennaTestSessions);
      this.reconcileScanSessions(scanSessions);
    } catch (e) {
      // Don't spam — log at debug. Real operator-visible errors will
      // surface via the SSE channel anyway when reads stop flowing.
      log.debug("active-sessions poll failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.polling = false;
    }
  }

  /** Forward the current scan-session reader set to the supervisor.
   *  Cheap to call every poll (the supervisor diffs internally). */
  private reconcileScanSessions(scanSessions: ActiveScanSession[]): void {
    if (!this.hooks) return;
    const readerIds = new Set<string>(scanSessions.map((s) => s.readerId));
    this.hooks.setActiveScanSessionReaders(readerIds);
  }

  private reconcile(sessions: ActiveAntennaTestSession[]): void {
    if (!this.hooks) return; // supervisor not attached yet
    const desiredById = new Map(sessions.map((s) => [s.id, s]));

    // End sessions that disappeared.
    for (const [id, applied] of this.applied) {
      if (!desiredById.has(id)) {
        log.info("antenna-test: session ended, leaving TEST_MODE", {
          sessionId: id,
          readerId: applied.readerId,
        });
        this.hooks.leaveTestMode(applied.readerId);
        this.applied.delete(id);
        this.stats.delete(id);
        this.sweep.delete(id);
      }
    }

    // Start / update sessions that are present.
    for (const s of sessions) {
      const prior = this.applied.get(s.id);
      const next: TestSessionApplied = {
        sessionId: s.id,
        readerId: s.readerId,
        antennaNumber: s.antennaNumber,
        flags: s.flags,
      };
      const flagsChanged =
        prior !== undefined &&
        (prior.flags.powerArg !== s.flags.powerArg ||
          prior.flags.readTimeMs !== s.flags.readTimeMs ||
          prior.flags.cycleMode !== s.flags.cycleMode ||
          prior.flags.tagFocus !== s.flags.tagFocus);
      if (prior === undefined) {
        log.info("antenna-test: session started, entering TEST_MODE", {
          sessionId: s.id,
          readerId: s.readerId,
          antennaNumber: s.antennaNumber,
          flags: s.flags,
          sweep: s.sweep ?? null,
        });
        // If the session is a sweep, set up the sweep state — the timer
        // will keep bumping currentPowerArg every dwellMs.
        if (s.sweep) {
          const totalSteps = Math.max(
            1,
            Math.ceil(
              (s.sweep.endPowerArg - s.sweep.startPowerArg) / s.sweep.stepPowerArg,
            ) + 1,
          );
          this.sweep.set(s.id, {
            startPowerArg: s.sweep.startPowerArg,
            endPowerArg: s.sweep.endPowerArg,
            stepPowerArg: s.sweep.stepPowerArg,
            dwellMs: s.sweep.dwellMs,
            currentPowerArg: s.sweep.startPowerArg,
            stepIndex: 0,
            totalSteps,
            stepStartedAtMs: Date.now(),
            done: false,
          });
        }
        this.applied.set(s.id, next);
        this.hooks.enterTestMode(next);
      } else if (flagsChanged) {
        log.info("antenna-test: flags changed, respawning child", {
          sessionId: s.id,
          readerId: s.readerId,
          flags: s.flags,
        });
        this.applied.set(s.id, next);
        this.hooks.enterTestMode(next); // supervisor treats this as kill+respawn
      }
    }
  }

  // ── sweep ────────────────────────────────────────────────────────────────

  /**
   * Called every FLUSH_INTERVAL_MS (= 100 ms). For each active sweep, if
   * dwellMs has elapsed since the step started, advance to the next power
   * level and tell the supervisor to respawn the child with the new power.
   */
  private tickSweep(): void {
    if (!this.hooks) return;
    const now = Date.now();
    for (const [sessionId, sw] of this.sweep) {
      if (sw.done) continue;
      if (now - sw.stepStartedAtMs < sw.dwellMs) continue;
      // Time to advance.
      const next = sw.currentPowerArg + sw.stepPowerArg;
      if (next > sw.endPowerArg) {
        sw.done = true;
        log.info("antenna-test: sweep completed at top of ramp", {
          sessionId,
          atPowerArg: sw.currentPowerArg,
        });
        continue;
      }
      sw.currentPowerArg = next;
      sw.stepIndex += 1;
      sw.stepStartedAtMs = now;
      const applied = this.applied.get(sessionId);
      if (applied) {
        const updated: TestSessionApplied = {
          ...applied,
          flags: { ...applied.flags, powerArg: next },
        };
        this.applied.set(sessionId, updated);
        this.hooks.enterTestMode(updated);
        log.info("antenna-test: sweep advanced", {
          sessionId,
          stepIndex: sw.stepIndex,
          totalSteps: sw.totalSteps,
          newPowerArg: next,
        });
      }
    }
  }

  // ── flush ────────────────────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    // Group by session so we can send one ingest POST per active session.
    const bySession = new Map<string, AntennaTestIngestRead[]>();
    const drained = this.queue;
    this.queue = [];
    for (const p of drained) {
      let arr = bySession.get(p.sessionId);
      if (!arr) {
        arr = [];
        bySession.set(p.sessionId, arr);
      }
      arr.push(p.read);
    }
    for (const [sessionId, reads] of bySession) {
      const stats = this.stats.get(sessionId);
      const sw = this.sweep.get(sessionId);
      try {
        // Stamp every read with the sweep's CURRENT power so the UI can
        // record first-read-power per EPC. (Reads from the supervisor
        // already have the spawn-time power from supervisor; we override
        // here with the sweep's view since they should be identical in
        // sweep mode.)
        if (sw) {
          for (const r of reads) {
            r.powerArg = sw.currentPowerArg;
          }
        }
        await postAntennaTestReads(this.env, {
          sessionId,
          reads,
          stats: stats
            ? {
                uniqueEpcs: stats.uniqueEpcs.size,
                totalReads: stats.totalReads,
                droppedBadCrc: stats.droppedBadCrc,
              }
            : undefined,
          sweepProgress: sw
            ? {
                currentPowerArg: sw.currentPowerArg,
                stepIndex: sw.stepIndex,
                totalSteps: sw.totalSteps,
                stepEndsAtMs: sw.stepStartedAtMs + sw.dwellMs,
              }
            : undefined,
        });
      } catch (e) {
        log.warn("antenna-test ingest POST failed; reads dropped", {
          sessionId,
          batch: reads.length,
          err: e instanceof Error ? e.message : String(e),
        });
        // Don't requeue — these are diagnostic reads; lost ones don't matter.
        // Operator will keep seeing fresh ones as the test continues.
      }
    }
  }
}
