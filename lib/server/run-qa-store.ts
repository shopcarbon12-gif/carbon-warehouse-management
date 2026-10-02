/**
 * Run-scoped QA: the panel images of one generation run, plus the verdict the
 * two run-level judges produce from them.
 *
 * The old judge ran once per panel and never saw the other three. That is why
 * it could not answer the only question the operator actually asks — "are these
 * eight pictures the same outfit on the same person?" — and why it kept failing
 * frames for what a single panel seemed to imply. A consistency judge has to
 * see the whole run at once, so the panels are collected here as they land and
 * audited together when the last one is in.
 *
 * In-memory on purpose, same idiom as generate-jobs.ts. The images only have to
 * outlive the seconds between the last panel landing and the client asking for
 * the verdict. A container restart means no flags for that run, which the
 * Studio reports rather than passing off as "QA passed".
 */

export type RunPanelImage = {
  panel: number;
  poseA: number | null;
  poseB: number | null;
  b64: string;
  /** studio_generations row for this panel, so findings can be logged back. */
  logId: string | null;
};

export type RunQaFinding = {
  /** Crop this applies to. `both` flags the whole panel. */
  panel: number;
  frame: "left" | "right" | "both";
  text: string;
};

export type RunQaVerdict = {
  findings: RunQaFinding[];
  /** Per-crop observations shown as notes: they point at a frame but never
   *  unselect it, for checks not reliable enough to cost the operator a crop. */
  advisories: RunQaFinding[];
  notes: string[];
  /** Neither judge committed — no verdict, not a pass. */
  unavailable: boolean;
};

/**
 * The resolved references for the run. The generate route has already fetched
 * and inlined these as data URLs; re-sending them from the browser would push
 * megabytes back up the wire for no gain, so they are stashed alongside the
 * first panel and the judges read them from here.
 */
export type RunQaContext = {
  itemRefs: string[];
  itemRefViews: ("general" | "front" | "back")[];
  modelRefs: string[];
  itemSpec: string;
  itemType: string;
  /** Operator-confirmed colourway, when this run renders one. Colour is the one
   *  attribute the reference photographs do NOT settle — the same black cloth
   *  reads charcoal under room light — so the judge is given the name instead. */
  colorName: string;
};

type RunEntry = {
  createdAt: number;
  panels: Map<number, RunPanelImage>;
  context: RunQaContext | null;
};

type VerdictEntry = {
  createdAt: number;
  finishedAt: number | null;
  verdict: RunQaVerdict | null;
};

const RUN_TTL_MS = 15 * 60_000;
const VERDICT_TTL_MS = 10 * 60_000;
/* Four 1536x1024 PNGs is roughly 10 MB of base64 per run. Three runs is the
   most this ever needs to hold — one in flight, two being collected. */
const MAX_RUNS = 3;
const MAX_VERDICTS = 16;
const MAX_PANELS_PER_RUN = 8;

const G = globalThis as unknown as {
  __runQaImages?: Map<string, RunEntry>;
  __runQaVerdicts?: Map<string, VerdictEntry>;
};
const runs: Map<string, RunEntry> = G.__runQaImages ?? (G.__runQaImages = new Map());
const verdicts: Map<string, VerdictEntry> = G.__runQaVerdicts ?? (G.__runQaVerdicts = new Map());

/** Ids come from the browser: the run tag, or the run tag plus a suffix. */
export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,96}$/.test(id);
}

function pruneRuns(now: number): void {
  for (const [id, e] of runs) {
    if (now - e.createdAt > RUN_TTL_MS) runs.delete(id);
  }
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next();
    if (oldest.done) break;
    runs.delete(oldest.value);
  }
}

function pruneVerdicts(now: number): void {
  for (const [id, e] of verdicts) {
    if (now - (e.finishedAt ?? e.createdAt) > VERDICT_TTL_MS) verdicts.delete(id);
  }
  while (verdicts.size > MAX_VERDICTS) {
    const oldest = verdicts.keys().next();
    if (oldest.done) break;
    verdicts.delete(oldest.value);
  }
}

/** Called as each panel finishes rendering. Last write for a panel wins, so a
 *  regenerated panel replaces the image the judges will compare. */
export function stashRunPanel(runId: string, image: RunPanelImage, context?: RunQaContext): void {
  const now = Date.now();
  pruneRuns(now);
  const entry =
    runs.get(runId) ?? { createdAt: now, panels: new Map<number, RunPanelImage>(), context: null };
  if (entry.panels.size >= MAX_PANELS_PER_RUN && !entry.panels.has(image.panel)) return;
  entry.panels.set(image.panel, image);
  /* Every panel of a run carries the same references; the first one to arrive
     wins and the rest are ignored rather than re-stored. */
  if (context && !entry.context) entry.context = context;
  runs.set(runId, entry);
}

export function readRunContext(runId: string): RunQaContext | null {
  pruneRuns(Date.now());
  return runs.get(runId)?.context ?? null;
}

/** Panels collected so far, in panel order. */
export function readRunPanels(runId: string): RunPanelImage[] {
  pruneRuns(Date.now());
  const entry = runs.get(runId);
  if (!entry) return [];
  return [...entry.panels.values()].sort((a, b) => a.panel - b.panel);
}

/** The images are large; drop them as soon as the judges have looked. */
export function releaseRunPanels(runId: string): void {
  runs.delete(runId);
}

/**
 * Run the judges detached from the response. Never rejects: a thrown judge is
 * recorded as `unavailable` so the client stops waiting and says so.
 */
export function startRunQa(id: string, work: () => Promise<RunQaVerdict>): Promise<RunQaVerdict> {
  const now = Date.now();
  pruneVerdicts(now);
  const entry: VerdictEntry = { createdAt: now, finishedAt: null, verdict: null };
  verdicts.set(id, entry);
  return work()
    .catch((): RunQaVerdict => ({ findings: [], advisories: [], notes: [], unavailable: true }))
    .then((verdict) => {
      entry.verdict = verdict;
      entry.finishedAt = Date.now();
      pruneVerdicts(entry.finishedAt);
      return verdict;
    });
}

/** True when a verdict for this id is already running or done. */
export function hasRunQa(id: string): boolean {
  pruneVerdicts(Date.now());
  return verdicts.has(id);
}

/** Poll target. A claimed verdict is dropped — the client has it. */
export function claimRunQa(
  id: string,
): { status: "running" } | { status: "done"; verdict: RunQaVerdict } | { status: "missing" } {
  pruneVerdicts(Date.now());
  const entry = verdicts.get(id);
  if (!entry) return { status: "missing" };
  if (!entry.verdict) return { status: "running" };
  const verdict = entry.verdict;
  verdicts.delete(id);
  return { status: "done", verdict };
}
