/**
 * Shared vocabulary between the item analysis (/api/openai/item-spec) and the
 * generator (/api/generate) about the ONE thing they kept disagreeing on: what
 * the back of the garment looks like.
 *
 * The back has three states, not two, and collapsing them produced both
 * failure modes at once — an invented back print, and a real one dropped:
 *   design  — a reference shows a design on the back.
 *   plain   — a reference shows the back and it carries nothing.
 *   unknown — no reference shows the back. "No evidence" is NOT "no design".
 */
export type BackView = "unknown" | "plain" | "design";

/* Byte / line ceiling for the numbered lock list. The generate route caps the
   spec again (slightly higher, for operator edits) before appending it. */
export const LOCK_TEXT_MAX_BYTES = 3500;
export const LOCK_TEXT_MAX_LINES = 48;

export type StudioRefView = "general" | "front" | "back";

/**
 * Which photos a spec was computed for, as one comparable string.
 *
 * The Studio stores this next to the spec (`spec_refs_key`) and treats a
 * mismatch as "the photos changed — re-analyze". Anything else that reads the
 * spec must be able to ask the same question, or it will present a spec
 * computed for a different set of photos as current fact. Shared so the two
 * can never drift into disagreeing about what "unchanged" means.
 */
export function studioRefViewKey(refs: Array<{ url: string; view?: StudioRefView | null }>): string {
  const lists: Record<StudioRefView, string[]> = { general: [], front: [], back: [] };
  for (const r of refs || []) {
    const view = (r?.view ?? "general") as StudioRefView;
    (lists[view] ?? lists.general).push(String(r?.url ?? ""));
  }
  return (["general", "front", "back"] as const).map((k) => `${k}:${lists[k].join(",")}`).join("|");
}

const DESIGN_NOUN =
  /\b(?:print|printed|graphic|logo|text|letter|word|wordmark|artwork|embroider|patch|appliqu|emblem|illustration|motif|pattern|badge|stripe|slogan|tagline|image|photo|drawing|number)\w*/i;

/**
 * The analyzer's `back_state` enum first; its free-text `back_view` only as a
 * fallback, read with the negations in mind ("no print on the back" is plain,
 * "plain back with a small logo" is a design, "not clearly visible" is unknown).
 */
export function classifyBackView(value: unknown, stateHint?: unknown): { state: BackView; text: string } {
  const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const hint = typeof stateHint === "string" ? stateHint.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (hint === "not_photographed" || hint === "unknown") return { state: "unknown", text: t };
  if (hint === "plain") return { state: "plain", text: t };
  if (hint === "design") return { state: "design", text: t };
  if (!t) return { state: "unknown", text: "" };
  // Explicit "we could not see it", stated as the whole answer.
  if (
    /^(?:not photographed|no (?:image|photo|reference)|not (?:visible|shown|provided|available|clearly visible|clear)|unknown|unclear|cannot|can't|n\/a|not applicable)\b/i.test(
      t
    )
  ) {
    return { state: "unknown", text: t };
  }
  // "plain … with / except / but / apart from a logo" is a design.
  if (/\b(?:with|except|but|apart from|other than|besides|aside from)\b[^.;]*?/i.test(t) && DESIGN_NOUN.test(t.replace(/\bno (?:print|graphic|design|text|logo|artwork|decoration)s?\b/gi, ""))) {
    if (/^(?:plain|clean|blank|solid|undecorated)\b/i.test(t) || /\b(?:is|:)\s*(?:plain|clean|blank|solid|undecorated)\b/i.test(t)) {
      return { state: "design", text: t };
    }
  }
  if (
    /^(?:plain|clean|blank|solid|undecorated|none|nothing|empty)\b/i.test(t) ||
    /\b(?:is|:)\s*(?:plain|clean|blank|solid|undecorated|empty)\b/i.test(t) ||
    /\bnothing (?:on|at) the back\b/i.test(t) ||
    /\bno (?:print|graphic|design|text|logo|artwork|decoration|branding)s?\b/i.test(t)
  ) {
    return { state: "plain", text: t };
  }
  if (DESIGN_NOUN.test(t)) return { state: "design", text: t };
  return { state: "unknown", text: t };
}

/**
 * Read the state back out of a lock list (the operator may have edited it).
 * `null` when the list carries no BACK line at all — an old spec, or one the
 * operator deleted the line from.
 */
export function parseSpecBackState(lockText: string): BackView | null {
  const m = String(lockText || "").match(/^\s*(?:\d+\.\s*)?BACK:\s*(.+)$/im);
  if (!m) return null;
  return classifyBackView(m[1]).state;
}

/**
 * Does any TEXT / LOGO / GRAPHIC / LABEL line PLACE something on the back?
 * Lines are numbered ("3. TEXT …"), which the previous `^(?:TEXT|…)` anchor
 * never matched — so this detector fired on nothing, every run was treated
 * as "back unknown", and the prompt told the model to keep the back plain
 * even when the references showed a back print.
 *
 * Quoted print text is ignored ("BACK TO THE FUTURE" on the chest is a front
 * print); the back of a sleeve and inside labels are not the garment's back.
 */
export function specListsBackDesign(lockText: string): boolean {
  return String(lockText || "")
    .split("\n")
    .some((line) => {
      if (!/^\s*(?:\d+\.\s*)?(?:TEXT|LOGO\/ICON|GRAPHIC\/PRINT|LABEL\/PATCH)\b/i.test(line)) return false;
      const stripped = line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''").replace(/“[^”]*”/g, "“”");
      if (/\b(?:inside|interior|inner|care label)\b/i.test(stripped)) return false;
      return (
        /\b(?:at|on|across|along|covering)\s+(?:the\s+)?(?:upper |lower |centre |center |full |whole |entire )?back\b(?!\s+of\s+(?:the\s+)?(?:left|right|each|both)?\s*sleeves?)/i.test(stripped) ||
        /\bplacement\s*[:=]?\s*"?back\b/i.test(stripped) ||
        /\bback,\s/i.test(stripped) ||
        /\bback (?:panel|yoke|centre|center|body|side)\b/i.test(stripped)
      );
    });
}

/** The one BACK line the prompt and the judge both receive, from the resolved
 *  state — so the spec can never say "not photographed" while the server says
 *  "the back carries the design listed above". */
export function canonicalBackLine(state: "present" | "absent" | "unknown" | "photo"): string {
  switch (state) {
    case "present":
      return "BACK: carries the design placed on the back in the TEXT / LOGO / GRAPHIC lines of this spec.";
    case "absent":
      return "BACK: plain — no print, text, graphic, logo or patch on the back.";
    case "photo":
      return "BACK: exactly what the BACK reference image(s) show — nothing more, nothing less.";
    default:
      return "BACK: not photographed — unknown; add nothing, keep the back plain in the item's own colour and construction.";
  }
}

/** Replace (or add) the spec's BACK line with the canonical one. */
export function withCanonicalBackLine(lockText: string, state: "present" | "absent" | "unknown" | "photo"): string {
  const canon = canonicalBackLine(state);
  const src = String(lockText || "");
  if (/^\s*(?:\d+\.\s*)?BACK:.*$/im.test(src)) return src.replace(/^(\s*(?:\d+\.\s*)?)BACK:.*$/im, `$1${canon}`);
  return src ? `${src}\n${canon}` : canon;
}
