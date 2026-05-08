import type { AgentEnv } from "./config.js";
import { postReads } from "./wms-client.js";
import { log } from "./log.js";
import type { ReadEvent } from "./monsoon-runner.js";

const FLUSH_INTERVAL_MS = 250;
const MAX_BATCH = 200;
/**
 * Per-reader queue cap before we drop oldest reads. Sized to absorb a
 * burst of ~30 s at the busiest single-reader rate we've measured live
 * (~600 reads/sec on a saturated antenna). Combined with parallel
 * per-reader flushing below, overflow now requires a sustained WMS
 * outage, not just a transient spike on one reader.
 */
const MAX_QUEUE_PER_READER = 20_000;

type Pending = {
  epcHex: string;
  antennaNumber?: number;
  rssi?: number;
  readAt: string;
};

/**
 * Buffers tag reads from many MonsoonRunners and POSTs them to the WMS in
 * small batches. Drops oldest entries if a reader's queue exceeds MAX_QUEUE
 * (which only happens when the WMS is unreachable for a long time).
 */
export class ReadAggregator {
  private readonly queues = new Map<string, Pending[]>();
  private readonly stats = { posted: 0, dropped: 0, failedFlushes: 0 };
  private flushHandle?: NodeJS.Timeout;
  private flushing = false;

  constructor(private readonly env: AgentEnv) {}

  start(): void {
    if (this.flushHandle) return;
    this.flushHandle = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.flushHandle) clearInterval(this.flushHandle);
    this.flushHandle = undefined;
  }

  enqueue(ev: ReadEvent): void {
    let q = this.queues.get(ev.readerId);
    const wasEmpty = !q || q.length === 0;
    if (!q) {
      q = [];
      this.queues.set(ev.readerId, q);
    }
    const receivedAtIso = ev.receivedAt.toISOString();
    for (const r of ev.reads) {
      q.push({
        epcHex: r.epcHex,
        antennaNumber: r.antennaNumber,
        readAt: receivedAtIso,
      });
    }
    if (q.length > MAX_QUEUE_PER_READER) {
      const overflow = q.length - MAX_QUEUE_PER_READER;
      q.splice(0, overflow);
      this.stats.dropped += overflow;
      log.warn("read queue overflow — dropping oldest", {
        reader_id: ev.readerId,
        dropped: overflow,
        queue_size_after: q.length,
      });
    }
    // First-byte fast-path: when a queue goes from empty → has-reads, fire
    // an immediate flush instead of waiting up to 250ms for the next tick.
    // Click-to-first-EPC cold-path was ~3-7s pre-fix; this saves the
    // tail 250ms (one tick) on the first read after a reader spawns.
    // Subsequent reads keep the 250ms buffer (avoids flooding the WMS
    // POST endpoint at high read rates).
    if (wasEmpty && ev.reads.length > 0 && !this.flushing) {
      void this.flush();
    }
  }

  /** Forget any queued reads for a reader (used when supervisor stops it). */
  flushAndDrop(readerId: string): void {
    this.queues.delete(readerId);
  }

  getStats(): { posted: number; dropped: number; failedFlushes: number } {
    return { ...this.stats };
  }

  /**
   * Tick handler — drains every per-reader queue concurrently. The previous
   * design ran the per-reader loops serially, so a saturated reader could
   * starve the others while its 5,000-deep queue drained one HTTP round-trip
   * at a time. With Promise.all each reader's flush awaits its own POST
   * stack, none of which blocks the others. New readers added at runtime
   * (via reconcile in the supervisor → enqueue) automatically participate
   * because we iterate the live `queues` Map every tick — no per-reader
   * registration step required.
   */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const readerIds = [...this.queues.keys()];
      await Promise.all(readerIds.map((id) => this.flushReader(id)));
    } finally {
      this.flushing = false;
    }
  }

  /** Drain ONE reader's queue. Stops on first POST failure for that reader
   *  (its remaining items stay queued for the next tick). Errors here don't
   *  affect other readers' parallel flushes. */
  private async flushReader(readerId: string): Promise<void> {
    const q = this.queues.get(readerId);
    if (!q) return;
    while (q.length > 0) {
      const slice = q.slice(0, MAX_BATCH);
      try {
        const { inserted } = await postReads(this.env, {
          readerId,
          reads: slice,
        });
        this.stats.posted += inserted ?? slice.length;
        q.splice(0, slice.length);
      } catch (e) {
        this.stats.failedFlushes++;
        log.warn("flush failed; will retry", {
          reader_id: readerId,
          queued: q.length,
          err: e instanceof Error ? e.message : String(e),
        });
        return; // stop trying this reader for this tick
      }
    }
  }
}
