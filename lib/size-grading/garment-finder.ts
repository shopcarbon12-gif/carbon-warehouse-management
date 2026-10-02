/**
 * Main-thread side of the garment finder: one worker, one photo at a time.
 * See find-garment.ts for what it does and garment-finder.worker.ts for why
 * it is a worker.
 */
import type { FindInput, FindResult, Stage } from "./find-garment";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: FindResult) => void; reject: (e: Error) => void; onStage?: (s: Stage) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./garment-finder.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<{ id: number; stage?: Stage; result?: FindResult; error?: string }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    if (ev.data.stage) p.onStage?.(ev.data.stage);
    else if (ev.data.error !== undefined) {
      pending.delete(ev.data.id);
      p.reject(new Error(ev.data.error));
    } else if (ev.data.result) {
      pending.delete(ev.data.id);
      p.resolve(ev.data.result);
    }
  };
  worker.onerror = (ev) => {
    // A worker that cannot start fails every photo the same way; say so once each.
    for (const [, p] of pending) p.reject(new Error(ev.message || "the finder could not start"));
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Start downloading the quick model while the operator is still choosing an item. */
export function warmUpFinder() {
  if (typeof window === "undefined") return;
  try {
    getWorker().postMessage({ id: 0, warm: true });
  } catch {
    /* the first photo will report it */
  }
}

export function findGarmentOffThread(input: FindInput, onStage?: (s: Stage) => void): Promise<FindResult> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onStage });
    try {
      getWorker().postMessage({ id, input });
    } catch (e) {
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
