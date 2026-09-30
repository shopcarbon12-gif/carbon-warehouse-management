/**
 * Deferred panel-QA verdicts.
 *
 * The compliance judge is a second gpt-4o vision call, and it used to run
 * BEFORE the panel was handed back — so the operator stared at nothing for an
 * extra 10-20 s per panel waiting on a verdict that only decorates an image
 * they already paid for. The image now returns immediately and the judge runs
 * on here; the Studio polls for the verdict and flags the crops in place.
 *
 * In-memory on purpose, same idiom as generate-jobs.ts: a verdict only has to
 * outlive the seconds between the image landing and the client asking for it,
 * not a deploy. A container restart simply means no flags for those crops —
 * which the Studio reports rather than passing off as "QA passed".
 */

export type PanelQaVerdict = {
  qaWarnings: string[];
  qaWarningsBySide: { left: string[]; right: string[] } | null;
  qaNotes: string[];
  /** The judge could not be reached / did not commit — no verdict, not a pass. */
  unavailable: boolean;
};

type Entry = {
  createdAt: number;
  finishedAt: number | null;
  verdict: PanelQaVerdict | null;
};

/** Verdicts are a few hundred bytes; a short window is plenty. */
const QA_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 32;

const G = globalThis as unknown as { __panelQa?: Map<string, Entry> };
const store: Map<string, Entry> = G.__panelQa ?? (G.__panelQa = new Map());

function prune(now: number): void {
  for (const [id, e] of store) {
    if (now - (e.finishedAt ?? e.createdAt) > QA_TTL_MS) store.delete(id);
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Ids come from the browser (they are the panel's job id plus a suffix). */
export function isValidQaId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(id);
}

/**
 * Run the judge detached from the response. Never rejects: a thrown judge is
 * recorded as `unavailable` so the client stops waiting and says so.
 */
export function runPanelQa(id: string, work: () => Promise<PanelQaVerdict>): Promise<PanelQaVerdict> {
  const now = Date.now();
  prune(now);
  const entry: Entry = { createdAt: now, finishedAt: null, verdict: null };
  store.set(id, entry);
  return work()
    .catch(
      (): PanelQaVerdict => ({ qaWarnings: [], qaWarningsBySide: null, qaNotes: [], unavailable: true }),
    )
    .then((verdict) => {
      entry.verdict = verdict;
      entry.finishedAt = Date.now();
      prune(entry.finishedAt);
      return verdict;
    });
}

/** Poll target. A claimed verdict is dropped — the client has it. */
export function claimPanelQa(
  id: string,
): { status: "running" } | { status: "done"; verdict: PanelQaVerdict } | { status: "missing" } {
  prune(Date.now());
  const entry = store.get(id);
  if (!entry) return { status: "missing" };
  if (!entry.verdict) return { status: "running" };
  const verdict = entry.verdict;
  store.delete(id);
  return { status: "done", verdict };
}
