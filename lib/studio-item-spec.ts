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
export function studioRefViewKey(refs: Array<{ url: string; view?: StudioRefView | "styling" | null }>): string {
  const lists: Record<StudioRefView, string[]> = { general: [], front: [], back: [] };
  for (const r of refs || []) {
    /* "Style with" photos are other products worn alongside this one. The spec
       never describes them, so adding or removing one does not stale it. */
    if (r?.view === "styling") continue;
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

/* ------------------------------------------------------------------------ */
/* Spec risk: what to check before paying for four panels.                   */
/* ------------------------------------------------------------------------ */

export type SpecIssue = { code: string; line?: number; message: string };

/** A second, independent read of one quoted text (/api/openai/item-spec `textReadings`). */
export type TextReading = { quoted: string; reading: string | null };

/*
 * Every wrong current-Studio photo the 2026-10-14 audit traced back ended at a
 * spec line the renders obeyed in all four panels: flap buttons the jacket does
 * not have, "CARRON JEANS" for the CARBON patch, a styling tank's print locked
 * as product text, "no pleat" on a Double Pleated trouser. Seven of 134 specs
 * had ever been read by a person. These checks only READ the lock text (old
 * stored specs work unchanged) and point at the line to check.
 */

/* Construction words in a product name, and how a spec line would deny them.
   `feature` finds the feature in a spec line; `skipZone` lists the ZONE names
   where saying "none" does not contradict the name — a pleated skirt or
   trouser keeps a flat waistband (Leopard Print Pleated Skort: "WAISTBAND:
   flat, no pleats", "FRONT OF LEG: pleated" — correct). */
type NameRule = { name: RegExp; label: string; feature: RegExp; skipZone?: RegExp; flatDenies?: boolean };
const NAME_RULES: NameRule[] = [
  { name: /\bpleat(?:ed|s)?\b/i, label: "Pleated", feature: /pleat/i, skipZone: /waist|belt loop|hem|cuff|closure|fly|pocket/i, flatDenies: true },
  { name: /\bruch(?:ed|ing)?\b/i, label: "Ruched", feature: /ruch|gather/i, skipZone: /waist|belt loop|closure|fly|pocket/i },
  { name: /\bchains?\b/i, label: "Chain", feature: /\bchains?\b/i },
  { name: /\bknot(?:ted|s)?\b/i, label: "Knot", feature: /\bknot/i },
  { name: /\bzip(?:per|ped|s)?\b/i, label: "Zip", feature: /\bzip/i },
  { name: /\b(?:one[- ]button|buttoned|buttons?|button[- ](?:down|up|front))\b/i, label: "Button", feature: /\bbuttons?\b/i },
  { name: /\bhalter\b/i, label: "Halter", feature: /\bhalter/i },
  { name: /\bcut[- ]?outs?\b/i, label: "Cut-out", feature: /cut[- ]?outs?|keyhole/i },
  { name: /\bbelted\b/i, label: "Belted", feature: /\bbelt(?!\s*loops?)\b|\bbelted\b|\bsash\b|\bself[- ]belt/i, skipZone: /belt loop/i },
  { name: /\b(?:ripped|distressed|destroyed)\b/i, label: "Ripped / Distressed", feature: /\brip(?:s|ped)?\b|\bdistress|\btears?\b|\bholes?\b|\bfray/i },
  { name: /\bcargo\b/i, label: "Cargo", feature: /\bcargo\b/i },
  { name: /\b(?:drawstring|drawcord)\b/i, label: "Drawstring", feature: /\bdraw(?:string|cord)/i },
  { name: /\bwrap\b/i, label: "Wrap", feature: /\bwrap|crossover|overlap/i },
  { name: /\btie(?:[- ]front|d)?\b(?![- ]?d(?:ye|ie))/i, label: "Tie", feature: /\bties?\b|\btied\b|\bbow\b|\bknot/i },
  { name: /\b(?:ruffled?|frill(?:ed|y)?)\b/i, label: "Ruffle", feature: /ruffle|frill|flounce/i },
  { name: /\blace\b(?![- ]up)/i, label: "Lace", feature: /\blace\b(?![- ]up)/i },
  { name: /\bmesh\b/i, label: "Mesh", feature: /\bmesh\b/i },
  { name: /\bsequin(?:ned|s)?\b/i, label: "Sequin", feature: /\bsequin/i },
  { name: /\b(?:crossover|criss[- ]?cross)\b/i, label: "Crossover", feature: /cross|wrap|overlap/i },
  { name: /\bdouble[- ]breasted\b/i, label: "Double-breasted", feature: /double[- ]breasted|two (?:rows|columns) of buttons/i },
  { name: /\bdouble[- ]waist(?:band|ed)?\b/i, label: "Double waist", feature: /double[- ]waist|two waistbands|double band/i },
];

const NEGATED_BEFORE = /\b(?:no|not|non|without|never|zero|un)[\s-]*(?:\w+[\s-]+){0,3}$/i;

/** Does this line mention the feature positively (at least once, not denied)? */
function mentionsPositively(detail: string, feature: RegExp): boolean {
  const re = new RegExp(feature.source, feature.flags.includes("g") ? feature.flags : `${feature.flags}g`);
  for (const m of detail.matchAll(re)) {
    const before = detail.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0).split(/[,;.:()—]/).pop() ?? "";
    const word = detail.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0);
    if (NEGATED_BEFORE.test(before) || /un$/i.test(word)) continue;
    const after = detail.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 24);
    if (/^\w*\s*[:—-]?\s*(?:none|absent|not (?:present|visible))\b/i.test(after)) continue;
    return true;
  }
  return false;
}

function deniesFeature(zone: string, detail: string, rule: NameRule): boolean {
  if (rule.skipZone && zone && rule.skipZone.test(zone)) return false;
  const re = new RegExp(rule.feature.source, `${rule.feature.flags.replace("g", "")}g`);
  for (const m of detail.matchAll(re)) {
    const before = detail.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0).split(/[,;.:()—]/).pop() ?? "";
    if (NEGATED_BEFORE.test(before)) return true;
  }
  /* "DISTRESSING: none — clean, undistressed fabric…" and "ZONE — BELT LOOPS: none". */
  if (/^none\b/i.test(detail) && (rule.feature.test(zone) || (rule.label.startsWith("Ripped") && /distress/i.test(zone)))) return true;
  /* "FRONT OF LEG: flat, no pressed crease" on a pleated trouser. */
  return Boolean(rule.flatDenies && /\b(?:leg|front|back|body|skirt|panel|bodice)\b/i.test(zone) && /^flat\b/i.test(detail));
}

type SpecLine = { n: number; head: string; zone: string; detail: string; raw: string };

function specLines(lockText: string): SpecLine[] {
  return String(lockText || "")
    .split("\n")
    .map((raw, i) => {
      const m = /^\s*(\d+)\.\s*(.*)$/.exec(raw);
      const body = (m ? m[2] : raw).trim();
      const n = m ? Number(m[1]) : i + 1;
      const zoneM = /^ZONE\s*[—-]\s*([^:]+):\s*(.*)$/i.exec(body);
      if (zoneM) return { n, head: "ZONE", zone: zoneM[1].trim(), detail: zoneM[2].trim(), raw: body };
      const headM = /^([A-Z][A-Z/ —-]*?):\s*(.*)$/.exec(body);
      return { n, head: headM ? headM[1].trim() : "", zone: headM ? headM[1].trim() : "", detail: headM ? headM[2].trim() : body, raw: body };
    })
    .filter((l) => l.raw);
}

/** Edit distance (insert / delete / substitute), for "CARRON" vs "CARBON". */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/* Real words a short distance from CARBON that are not misreads of it. */
const NEAR_CARBON_WORDS = new Set(["CARGO", "CARGOS", "CARSON", "BARON", "CANON", "CARTON", "CAPON", "CARBO"]);

function quotedTexts(s: string): string[] {
  return [...s.matchAll(/"([^"]{2,})"|“([^”]{2,})”|'([^']{2,})'/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim());
}

const normText = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function lineList(ns: number[]): string {
  const u = [...new Set(ns)];
  return u.length === 1 ? `line ${u[0]}` : `lines ${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

/**
 * The lines of a spec most likely to be wrong, before any render is paid for.
 * `blocking` = the spec contradicts the product's own name; the Studio holds
 * Generate until the operator confirms the spec. `warnings` = lines worth one
 * look at the real garment. Reads only the text, so it works on stored specs.
 */
export function specRiskReport(
  lockText: string,
  ctx: {
    productName: string;
    itemType: string;
    isAccessory: boolean;
    refCount: number;
    /** A person has edited / confirmed the spec (Studio `specConfirmed`). */
    specConfirmed?: boolean;
    /** The item-spec route's second, independent read of each quoted text. */
    textReadings?: TextReading[];
  },
): { blocking: SpecIssue[]; warnings: SpecIssue[] } {
  const blocking: SpecIssue[] = [];
  const warnings: SpecIssue[] = [];
  const all = specLines(lockText);
  /* The Garment line is a name, not evidence; OUTFIT lines describe the clothes
     worn WITH the product. */
  const product = all.filter((l) => !/^garment$/i.test(l.head) && !/^OUTFIT\b/i.test(l.raw));
  const name = `${ctx.productName || ""} ${ctx.itemType || ""}`;

  for (const rule of NAME_RULES) {
    if (!rule.name.test(name)) continue;
    const confirmed = product.some((l) => mentionsPositively(l.raw.replace(/^ZONE\s*[—-]\s*/i, ""), rule.feature) && !deniesFeature(l.zone, l.detail, rule));
    if (confirmed) continue;
    const denying = product.filter((l) => deniesFeature(l.zone, l.detail, rule));
    if (denying.length) {
      const first = denying[0];
      blocking.push({
        code: "name_contradiction",
        line: first.n,
        message: `"${rule.label}" is in the product name, but ${lineList(denying.map((l) => l.n))} ${denying.length > 1 ? "say" : "says"} there is none ("${first.detail.slice(0, 80)}"). Check the garment: fix the line if it has the feature, or confirm the spec if the name is wrong.`,
      });
    } else if (!ctx.isAccessory) {
      warnings.push({
        code: "name_feature_unmentioned",
        message: `"${rule.label}" is in the product name, but no line of the spec describes it. If the garment has it, add a line saying where and how — a feature the spec leaves out is left out of every panel.`,
      });
    }
  }

  const textLines = product.filter((l) => /^TEXT\b/i.test(l.raw));
  for (const l of product) {
    for (const q of quotedTexts(l.raw)) {
      const t = normText(q);
      if (!t || t === "CARBON" || t === "CARBON JEANS") continue;
      const near =
        (t.length >= 8 && levenshtein(t, "CARBON JEANS") <= 2) ||
        t.split(" ").some((w) => w.length >= 4 && w !== "CARBON" && !NEAR_CARBON_WORDS.has(w) && levenshtein(w, "CARBON") <= 2);
      if (near) {
        warnings.push({
          code: "carbon_text_misread",
          line: l.n,
          message: `Line ${l.n} quotes "${q}" — that is probably the CARBON mark misread. Check the label and correct the line; every panel prints exactly what it says.`,
        });
        break;
      }
    }
  }

  /* No blanket "check every quote" reminder: it showed on every spec with a
     TEXT line — even a correct "CARBON JEANS" — and read as an error (owner,
     2026-10-14). Only evidence warns: a CARBON near-miss above, or the second
     independent read below disagreeing with the quote. */

  for (const r of ctx.textReadings ?? []) {
    if (!r?.reading || !r.quoted || normText(r.reading) === normText(r.quoted)) continue;
    const l = textLines.find((x) => x.raw.includes(`"${r.quoted}"`));
    if (!l) continue; // the operator already changed that line
    warnings.push({
      code: "text_disagreement",
      line: l.n,
      message: `Line ${l.n} reads "${r.quoted}"; a second read of the photos gives "${r.reading}". Check the garment and correct line ${l.n}.`,
    });
  }

  /* No "the analysis adds flap buttons by habit" reminder: it fired on every
     spec with buttoned chest flaps — a trucker jacket or vest that really has
     them included — and read as an error (owner, 2026-10-14). Like the text
     reminder above, a warning needs evidence, not a habit of the analyzer. */

  if (ctx.isAccessory && ctx.refCount <= 1) {
    warnings.push({
      code: "accessory_single_photo",
      message:
        "Only one photo of this accessory. Bead counts, spacers and the clasp are read off a single picture and the worn shots follow those words — add a close-up of the beads and a photo of the whole loop.",
    });
    const counted = product.filter(
      (l) =>
        /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty[\w-]*|thirty[\w-]*|forty[\w-]*)\b/i.test(l.detail) &&
        /\b(?:beads?|charms?|discs?|links?|stones?|spacers?|pearls?|groups?|clusters?|strands?)\b/i.test(l.detail),
    );
    if (counted.length) {
      warnings.push({
        code: "accessory_counts",
        line: counted[0].n,
        message: `${lineList(counted.map((l) => l.n)).replace(/^l/, "L")} count beads / charms from one photo — count them on the real piece before generating.`,
      });
    }
  }

  const styled = product.filter(
    (l) =>
      /^(?:TEXT|LOGO\/ICON|GRAPHIC\/PRINT)\b/i.test(l.raw) &&
      /\btop[_ ]under\b|\boutfit\b|\bstyling\b|\bworn (?:under|with)\b/i.test(l.raw.replace(/"[^"]*"|“[^”]*”/g, "")),
  );
  for (const l of styled) {
    warnings.push({
      code: "styling_text_locked",
      line: l.n,
      message: `Line ${l.n} locks text or a print on a STYLING piece, not on the product. Delete it — the styling piece is described in its OUTFIT line, and its print is left off unless "Keep prints on styling pieces" is ticked.`,
    });
  }

  return { blocking, warnings };
}

/* ── Second-look corrections (owner, 2026-10-14: a vest with PLAIN chest flaps
   got "flap pockets with button closure" and an oversized drop-shoulder vest
   got "regular fit"; every panel drew what the spec said). The item-spec route
   asks one targeted question about the photos and these rewrite the lines. ── */

const FLAP_WORDS = /\b(?:flaps?|chest pockets?|breast pockets?)\b/i;
const FLAP_FASTENER = /\b(?:buttons?|buttoned|snaps?|press studs?|poppers?|zips?|zippers?)\b/i;
const FLAP_FASTENER_DENIED = /\b(?:no|without)\s+(?:\w+\s+){0,2}(?:buttons?|snaps?|zips?|zippers?)\b/i;

/** Spec lines that put a button / snap / zip on the chest-pocket flaps. */
export function flapFastenerLines(lockText: string): number[] {
  return String(lockText || "")
    .split("\n")
    .map((raw) => {
      const m = /^\s*(\d+)\.\s*(.*)$/.exec(raw);
      return m ? { n: Number(m[1]), text: m[2] } : null;
    })
    .filter((l): l is { n: number; text: string } => !!l && !/^OUTFIT\b/i.test(l.text))
    .filter((l) => FLAP_WORDS.test(l.text) && FLAP_FASTENER.test(l.text) && !FLAP_FASTENER_DENIED.test(l.text))
    .map((l) => l.n);
}

/** Those lines rewritten for plain flaps (the photos show no fastener on them). */
export function withPlainFlaps(lockText: string): string {
  const lines = new Set(flapFastenerLines(lockText));
  if (!lines.size) return lockText;
  return lockText
    .split("\n")
    .map((raw) => {
      const m = /^(\s*(\d+)\.\s*)(.*)$/.exec(raw);
      if (!m || !lines.has(Number(m[2]))) return raw;
      const body = m[3]
        .replace(/[,;]?\s*(?:with\s+)?(?:an?\s+)?(?:\w+\s+)?(?:buttons?|buttoned|snaps?|press studs?|poppers?|zips?|zippers?)(?:\s+(?:closures?|fastenings?|flaps?))?/gi, "")
        .replace(/\s+([.,;])/g, "$1")
        .replace(/[.\s]+$/, "");
      return `${m[1]}${body} — plain flaps, no button, snap or zip on them.`;
    })
    .join("\n");
}

const FIT_CLASS: Record<string, "big" | "mid" | "small"> = {
  oversized: "big", boxy: "big", baggy: "big", loose: "big", relaxed: "big",
  regular: "mid", classic: "mid", straight: "mid",
  slim: "small", skinny: "small", fitted: "small", tight: "small",
};

/**
 * The FIT/SILHOUETTE line with a second look's fit, when it puts the garment in
 * a different size class (oversized vs regular vs slim), and the extended /
 * dropped shoulder when the line does not say so. `changed` is false when the
 * spec already agrees.
 */
export function withCheckedFit(lockText: string, fit: string, dropShoulder: boolean): { text: string; changed: boolean; was: string } {
  const want = String(fit || "").toLowerCase().trim();
  let changed = false;
  let was = "";
  const text = String(lockText || "").replace(/^(\s*\d+\.\s*FIT\/SILHOUETTE:\s*)(.*)$/m, (line, head: string, rest: string) => {
    was = rest.trim();
    if (/set by the item instruction/i.test(rest)) return line; // the person holding it decided
    const words = rest.toLowerCase().match(/\b(?:oversized|boxy|baggy|loose|relaxed|regular|classic|straight|slim|skinny|fitted|tight)\b/g) ?? [];
    const have = words.map((x) => FIT_CLASS[x]).find(Boolean);
    const need = FIT_CLASS[want];
    let out = rest;
    /* Only the clear misreads: oversized read as regular / slim, or the reverse.
       Slim vs regular is too fine to overrule the first read. */
    if (need && have !== need && (need === "big" || have === "big")) {
      const kept = rest.replace(SPEC_FIT_WORDS, "").replace(/^[\s,;—-]+/, "").trim();
      const fitWords = want === "oversized" || want === "boxy" ? "oversized, boxy fit" : `${want} fit`;
      out = `${fitWords}${kept ? `, ${kept}` : "."}`;
      changed = true;
    }
    if (dropShoulder && !/\b(?:drop(?:ped)?|extended)[\s-]+shoulders?\b/i.test(out)) {
      const parts = out.split(/,\s*/);
      const at = Math.max(0, parts.findIndex((p) => /\bfit\b/i.test(p)));
      parts[at] = parts[at].replace(/[.\s]+$/, "") + " with extended, dropped shoulders" + (at === parts.length - 1 ? "." : "");
      out = parts.join(", ");
      changed = true;
    }
    return `${head}${out}`;
  });
  return { text, changed, was };
}

/* Fit words an operator writes in the item instruction ("RELAXED FIT",
   "oversized", "slim-fit"). A bare adjective only counts with a fit noun after
   it, except the ones that only ever describe a fit. */
const INSTRUCTION_FIT =
  /\b(?:(oversized|boxy|baggy)|(relaxed|regular|slim|skinny|loose|fitted|tight|tapered|straight|wide|cropped|longline|classic|athletic|muscle)[\s-]+(?:fit|fitting|cut|leg|silhouette))\b/i;
const SPEC_FIT_WORDS =
  /\b(?:oversized|boxy|baggy|relaxed|regular|slim|skinny|loose|fitted|tight|tapered|classic|athletic|muscle)(?:[\s-]+(?:fit|fitting|cut))?\b,?\s*/gi;

/**
 * The item instruction is written by the person holding the garment, so its
 * fit wins over the photo analysis' guess. The spec's own FIT/SILHOUETTE line
 * is rewritten to say so — a rule placed elsewhere in the prompt loses to the
 * line it contradicts (2026-10-13: instruction "RELAXED FIT", spec "regular
 * fit"; the renders swung between the two). Sleeves, neckline etc. stay.
 */
export function withInstructionFit(specText: string, instruction: string): string {
  const m = (instruction || "").match(INSTRUCTION_FIT);
  if (!m || !specText) return specText;
  const fit = m[0].toLowerCase().replace(/\s+/g, " ").trim();
  return specText.replace(/^(\s*\d+\.\s*FIT\/SILHOUETTE:\s*)(.*)$/m, (_line, head: string, rest: string) => {
    const kept = rest.replace(SPEC_FIT_WORDS, "").replace(/^[\s,;—-]+/, "").trim();
    return `${head}${fit} (set by the item instruction — overrides the photos)${kept ? `, ${kept}` : "."}`;
  });
}
