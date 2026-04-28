import type { AgentEnv } from "./config.js";
import { postReads } from "./wms-client.js";
import { log } from "./log.js";
import type { ReadEvent } from "./monsoon-runner.js";

const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH = 200;
const MAX_QUEUE_PER_READER = 5000;

type Pending = {
  epcHex: string;
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
    if (!q) {
      q = [];
      this.queues.set(ev.readerId, q);
    }
    const receivedAtIso = ev.receivedAt.toISOString();
    for (const r of ev.reads) {
      q.push({ epcHex: r.epcHex, readAt: receivedAtIso });
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
  }

  /** Forget any queued reads for a reader (used when supervisor stops it). */
  flushAndDrop(readerId: string): void {
    this.queues.delete(readerId);
  }

  getStats(): { posted: number; dropped: number; failedFlushes: number } {
    return { ...this.stats };
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [readerId, q] of this.queues) {
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
            break; // stop trying this reader for this tick
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
