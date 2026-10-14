/**
 * Resumable Carbon Studio panel generations.
 *
 * A panel takes OpenAI 60–90 s. Until now the whole thing lived inside one
 * in-flight `fetch`: if the operator switched apps, locked the phone, changed
 * browser tab or the WebView was frozen by Android, the connection died and the
 * finished image was lost — even though the server had completed (and paid for)
 * the render.
 *
 * The client now sends `x-generate-job: <id>`. We detach the generation from the
 * HTTP response: the work runs to completion regardless of what happens to the
 * connection, and the JSON body is parked here so the client can pick it up from
 * `GET /api/generate/job?id=…` when it comes back.
 *
 * In-memory on purpose (same idiom as `antenna-test-sessions.ts`): a job only
 * has to outlive a short disconnect, not a deploy. A container restart loses
 * in-flight runs exactly as it does today.
 *
 * Memory is bounded deliberately — a panel body is ~1.5–3 MB of base64 and this
 * box has filled its disk before (2026-05-10): short TTL, hard entry cap, and
 * the payload is dropped as soon as the client claims it.
 */

export type GenerateJobStatus = "running" | "done";

type GenerateJob = {
  id: string;
  status: GenerateJobStatus;
  createdAt: number;
  finishedAt: number | null;
  /** Serialized response body from handleGenerate (success OR error JSON). */
  body: string | null;
  /** Kept so a duplicate POST with the same id joins the run instead of paying twice. */
  promise: Promise<string> | null;
  /** Fired by the Studio's Abort button — cancels the in-flight OpenAI request. */
  controller: AbortController;
};

/** A finished body is claimable for this long. */
const JOB_TTL_MS = 15 * 60_000;
/** A leak guard only: the route's own deadlines end every generation well before this. */
const RUNNING_JOB_MAX_MS = 30 * 60_000;
/**
 * Cap on parked jobs (~3 MB each worst case). Oldest FINISHED bodies are
 * evicted first and a running job never is: an anchored run keeps panels 2-4
 * running while panel 1 renders, and evicting one would lose a render that is
 * still being paid for. 24 = six four-panel runs overlapping.
 */
const MAX_JOBS = 24;

/**
 * Pinned to globalThis so the same Map survives webpack/Next.js dev-mode
 * double-evaluation — `/api/generate` and `/api/generate/job` are separate
 * route bundles (see the note in antenna-test-sessions.ts).
 */
const G = globalThis as unknown as { __generateJobs?: Map<string, GenerateJob> };
const jobs: Map<string, GenerateJob> = G.__generateJobs ?? (G.__generateJobs = new Map());

/** Ids cancelled before their POST arrived; checked when the run starts. */
const CG = globalThis as unknown as { __generateJobsCancelled?: Map<string, number> };
const cancelledEarly: Map<string, number> = CG.__generateJobsCancelled ?? (CG.__generateJobsCancelled = new Map());

function prune(now: number): void {
  for (const [id, job] of jobs) {
    const age = now - (job.finishedAt ?? job.createdAt);
    if (age > (job.status === "running" ? RUNNING_JOB_MAX_MS : JOB_TTL_MS)) jobs.delete(id);
  }
  if (jobs.size <= MAX_JOBS) return;
  // Map preserves insertion order — the first finished entry is the oldest.
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.status !== "running") jobs.delete(id);
  }
}

/** Job ids come from the browser; keep them short and boring before using them as map keys. */
export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(id);
}

/**
 * Runs `work` detached from the caller's response. The returned promise resolves
 * with the response body text; the same text is parked for later claim. A second
 * call with a live id joins the existing run rather than starting another.
 */
export function runGenerateJob(id: string, work: (signal: AbortSignal) => Promise<string>): Promise<string> {
  const now = Date.now();
  prune(now);

  const existing = jobs.get(id);
  if (existing) {
    if (existing.promise) return existing.promise;
    if (existing.body !== null) return Promise.resolve(existing.body);
  }

  const job: GenerateJob = {
    id,
    status: "running",
    createdAt: now,
    finishedAt: null,
    body: null,
    promise: null,
    controller: new AbortController(),
  };
  jobs.set(id, job);

  job.promise = work(job.controller.signal)
    .then((body) => {
      job.body = body;
      return body;
    })
    .catch((err: unknown) => {
      // Park the failure too: the client should see "panel failed", not hang until timeout.
      const message = err instanceof Error ? err.message : "Generate failed";
      job.body = JSON.stringify({ error: message });
      return job.body;
    })
    .then((body) => {
      job.status = "done";
      job.finishedAt = Date.now();
      job.promise = null;
      prune(job.finishedAt);
      return body;
    });

  return job.promise;
}

/**
 * Poll target for a client whose connection died. Returns the parked body once
 * and then frees it — the caller has the image, we do not need the copy.
 */
export function claimGenerateJob(id: string): { status: GenerateJobStatus; body: string } | { status: "missing" } {
  prune(Date.now());
  const job = jobs.get(id);
  if (!job) return { status: "missing" };
  if (job.status === "running" || job.body === null) return { status: "running", body: "" };
  const body = job.body;
  jobs.delete(id);
  return { status: "done", body };
}

/**
 * The operator pressed Abort. Stops the OpenAI request mid-flight so no further
 * time is spent on it; the run resolves with an "aborted" body. Returns false
 * when there is nothing running under that id (already finished, or unknown).
 *
 * An id that has not reached the server yet (the POST is still in transit) is
 * remembered as cancelled, so the run refuses to start when it does arrive.
 */
export function cancelGenerateJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) {
    cancelledEarly.set(id, Date.now());
    return false;
  }
  if (job.status !== "running") return false;
  job.controller.abort();
  return true;
}

/** Was this id cancelled before its run started? Consumes the mark. */
export function takeEarlyCancel(id: string): boolean {
  const now = Date.now();
  for (const [k, at] of cancelledEarly) if (now - at > JOB_TTL_MS) cancelledEarly.delete(k);
  if (cancelledEarly.size > 200) cancelledEarly.clear();
  return cancelledEarly.delete(id);
}

/** Client got its result over the original connection — drop our copy now. */
export function releaseGenerateJob(id: string): void {
  const job = jobs.get(id);
  if (job && job.status === "done") jobs.delete(id);
}
