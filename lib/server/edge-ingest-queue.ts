import { getPool } from "@/lib/db";
import { reconcileInventoryFromEdge } from "@/lib/server/inventory-reconciler";
import type { ReconcilerBatchInput } from "@/lib/server/inventory-reconciler";

export type EdgeIngestQueueJob = ReconcilerBatchInput;

const queue: EdgeIngestQueueJob[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flushQueue();
  });
}

/**
 * Fire-and-forget background processing (after HTTP 202 returns).
 */
export function enqueueEdgeIngestJob(job: EdgeIngestQueueJob): void {
  queue.push(job);
  scheduleFlush();
}

async function flushQueue(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    console.error("[edge-ingest-queue] DATABASE_URL missing; dropping edge batch");
    queue.length = 0;
    return;
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    for (const job of batch) {
      try {
        const out = await reconcileInventoryFromEdge(pool, job);
        if (out.error) {
          console.error("[edge-ingest-queue] reconcile", job.scanContext, out.error);
        }
      } catch (e) {
        console.error("[edge-ingest-queue] reconcile failed", e);
      }
    }
  }
}
