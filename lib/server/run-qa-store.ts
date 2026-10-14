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
  /** The operator's instruction; it overrides the photos and spec, so the judge must too. */
  instruction: string;
  /** Lets the judges label each frame as fact: "back view", or an accessory shot's role. */
  modelGender?: string;
  accessoryKind?: string;
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
/* Four 1536x1024 PNGs is roughly 10 MB of base64 per run. An anchored run
   (panel 1 first, then 2-4) is in flight about twice as long, so one more run
   is held than the one-in-flight-two-being-collected this used to need. */
const MAX_RUNS = 4;
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

/**
 * The images are large; drop them as soon as the judges have looked.
 *
 * Except panel 1 of an anchored run whose other panels are still to come —
 * being gated, or held by the gate until "render the other panels anyway":
 * the QA of that run has to see panel 1 next to them. So while the run holds
 * nothing but its source panel, the source stays.
 */
export function releaseRunPanels(runId: string): void {
  const anchor = anchors.get(runId);
  const entry = runs.get(runId);
  const followersPending =
    anchor?.result?.status === "ok" &&
    ((anchor.gate !== null && !anchor.gateResult) || anchor.gateResult?.status === "flagged");
  if (entry && followersPending && [...entry.panels.keys()].every((p) => p === anchor?.result?.panel)) return;
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

/* ── Anchor: panel 1 sets the look ──────────────────────────────────────────
 *
 * The four panels of a run are four independent image calls, so whatever the
 * prompt leaves open (how the shoes are drawn, how the tee drapes) is drawn
 * four different ways. In an anchored run panel 1 renders first and panels
 * 2-4 attach it as a same-shoot reference. All four are still POSTed at once
 * (resume, Abort and the job ids are unchanged); the followers wait HERE, on
 * the server, for the source to land.
 *
 * Depth is always 1: only a panel rendered from the real references becomes an
 * anchor, never a follower. Same in-memory idiom as the panels above — a
 * container restart loses a waiting run exactly as it loses a rendering one.
 */

export type RunAnchorResult =
  | { status: "ok"; b64: string; panel: number; poseA: number | null; poseB: number | null }
  | { status: "failed"; panel: number; reason: string };

/** The accuracy judge on panel 1 alone, once per run, before 2-4 are paid for. */
export type AnchorGateResult = {
  status: "pass" | "flagged" | "unavailable";
  findings: RunQaFinding[];
  notes: string[];
};

type AnchorEntry = {
  createdAt: number;
  settledAt: number | null;
  result: RunAnchorResult | null;
  waiters: Set<(r: RunAnchorResult) => void>;
  gate: Promise<AnchorGateResult> | null;
  gateResult: AnchorGateResult | null;
};

const ANCHOR_TTL_MS = 15 * 60_000;
/* One 1536x1024 PNG (~2.5 MB of base64) per entry. */
const MAX_ANCHORS = 6;

const GA = globalThis as unknown as { __runAnchors?: Map<string, AnchorEntry> };
const anchors: Map<string, AnchorEntry> = GA.__runAnchors ?? (GA.__runAnchors = new Map());

/** Never drops an entry somebody is waiting on. */
function pruneAnchors(now: number): void {
  for (const [id, e] of anchors) {
    if (e.waiters.size) continue;
    if (now - (e.settledAt ?? e.createdAt) > ANCHOR_TTL_MS) anchors.delete(id);
  }
  if (anchors.size <= MAX_ANCHORS) return;
  for (const [id, e] of anchors) {
    if (anchors.size <= MAX_ANCHORS) break;
    if (!e.waiters.size) anchors.delete(id);
  }
}

function anchorEntry(runId: string, now: number): AnchorEntry {
  let entry = anchors.get(runId);
  if (!entry) {
    entry = { createdAt: now, settledAt: null, result: null, waiters: new Set(), gate: null, gateResult: null };
    anchors.set(runId, entry);
  }
  return entry;
}

/**
 * The source panel finished — rendered, refused, failed or aborted. Releases
 * every follower waiting on it. A second source for the same run (panel 1
 * regenerated under the same run id) replaces the first and its gate verdict.
 */
export function settleRunAnchor(runId: string, result: RunAnchorResult): void {
  const now = Date.now();
  pruneAnchors(now);
  const entry = anchorEntry(runId, now);
  entry.result = result;
  entry.settledAt = now;
  entry.gate = null;
  entry.gateResult = null;
  const waiting = [...entry.waiters];
  entry.waiters.clear();
  for (const wake of waiting) wake(result);
}

/** A follower waits for the source. Abortable (the Studio's Abort button) and bounded. */
export function waitRunAnchor(
  runId: string,
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<RunAnchorResult | { status: "timeout" } | { status: "aborted" }> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ status: "aborted" });
    const now = Date.now();
    pruneAnchors(now);
    const entry = anchorEntry(runId, now);
    if (entry.result) return resolve(entry.result);
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: RunAnchorResult | { status: "timeout" } | { status: "aborted" }) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      entry.waiters.delete(wake);
      resolve(r);
    };
    const wake = (r: RunAnchorResult) => finish(r);
    const onAbort = () => finish({ status: "aborted" });
    entry.waiters.add(wake);
    timer = setTimeout(() => finish({ status: "timeout" }), Math.max(0, opts.timeoutMs));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Gate the anchor once per run: the first follower to get a good anchor starts
 * the judge, every other follower shares its answer. Never rejects — a judge
 * that throws is `unavailable`, which holds nothing (QA flags, never blocks on
 * its own failure).
 */
export function gateRunAnchor(runId: string, work: () => Promise<AnchorGateResult>): Promise<AnchorGateResult> {
  const entry = anchors.get(runId);
  const run = () =>
    work().catch((): AnchorGateResult => ({ status: "unavailable", findings: [], notes: [] }));
  if (!entry || entry.result?.status !== "ok") return run();
  if (entry.gate) return entry.gate;
  const gate = run().then((r) => {
    if (entry.gate === gate) entry.gateResult = r;
    return r;
  });
  entry.gate = gate;
  return gate;
}

/** The gate verdict for this run, once there is one. */
export function readRunAnchorGate(runId: string): AnchorGateResult | null {
  return anchors.get(runId)?.gateResult ?? null;
}

/** The settled anchor for this run, without waiting — null while pending or after it aged out. */
export function peekRunAnchor(runId: string): RunAnchorResult | null {
  pruneAnchors(Date.now());
  return anchors.get(runId)?.result ?? null;
}
