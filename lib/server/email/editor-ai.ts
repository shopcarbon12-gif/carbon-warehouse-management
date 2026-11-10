/**
 * CarbonWMS Email Editor — AI inside the editor (phase 3, owner-approved plan 2026-11-09).
 *
 * TEXT ONLY: the AI writes words and picks catalog products; it never draws pictures (the owner
 * spent ~$100 on AI-drawn emails with nothing sendable). Pictures are the real catalog photos.
 *
 *   buildFromBrief  — "Write it with AI": a short brief → a whole editable email made of the
 *                     CARBON pre-built sections, its words written, its products chosen.
 *   rewriteText     — a text block rewritten (shorter, bolder, warmer, fix spelling, or your own
 *                     instruction): 3 options, the owner picks one (Ctrl+Z undoes it).
 *   subjectLines    — 6 subject + preview-text pairs for the email.
 *   checkEmail      — the check before sending: fixed rules (missing alt text, empty links, unknown
 *                     personal tags …) plus an AI read of the words (spelling, invented offers,
 *                     other brands, tone).
 */
import { openai, textModel } from "./config";
import { catalogLines, catalogSets, inStockCatalog, type CatalogProduct, type CatalogSet } from "./catalog";
import { STORE_TEXT } from "./brand";
import { MERGE_TAGS } from "./rules";
import { PREBUILT, darkenDoc, prebuiltSections } from "@/lib/email-editor/prebuilt";
import { defaultStyles, type Block, type EmailDoc, type GlobalStyles, type ProductItem, type Section } from "@/lib/email-editor/types";

const VOICE = `CARBON is an Orlando streetwear and going-out fashion store for men and women (a showroom + shopcarbon.com). Voice: short, confident, warm, a little editorial; no hype words ("amazing", "game-changer", "elevate"), no em dashes, no emoji unless asked. The brand is "CARBON" or "Carbon", never "Carbon Jeans". Never mention other brands or where clothes are made. Never invent discounts, percentages, prices, dates or free gifts: a personal discount is always the person's own code, written as the personal tags {{code}}, {{offer_amount}} and {{offer_ends}}.`;

async function askJson(instructions: string, input: string): Promise<Record<string, unknown>> {
  const r = await openai().responses.create({
    model: textModel(),
    instructions,
    input: `${input}\n\nAnswer with the JSON object described in your instructions.`,
    text: { format: { type: "json_object" } },
  });
  return JSON.parse(r.output_text || "{}") as Record<string, unknown>;
}

const str = (x: unknown, max = 400): string => (typeof x === "string" ? x.trim().slice(0, max) : "");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* -------------------------------------------------------------- text tools */

/** The plain words of some editor HTML (tags removed, entities decoded enough for the AI). */
export function words(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-4]|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const tagsIn = (s: string) => [...s.matchAll(/\{\{\s*([a-z_]+)/g)].map((m) => m[1]).sort();

const ALLOWED = new Set(["p", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "a", "br", "span", "ul", "ol", "li"]);

/** Only simple text tags survive; no scripts, no event handlers, no javascript: links. */
export function cleanHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string) => (ALLOWED.has(name.toLowerCase()) ? tag : ""))
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/href\s*=\s*(["'])\s*javascript:[^"']*\1/gi, 'href="#"');
}

export type RewriteAction = "shorter" | "longer" | "bolder" | "warmer" | "fix" | "custom";
const ACTION_ASK: Record<RewriteAction, string> = {
  shorter: "Make it noticeably shorter (about half), keeping the meaning.",
  longer: "Make it a little fuller (one more sentence or detail), still short.",
  bolder: "Make it bolder and more confident: punchier words, stronger verbs.",
  warmer: "Make it warmer and more personal, like a friend at the store talking.",
  fix: "Only fix spelling, grammar and punctuation. Change nothing else.",
  custom: "",
};

/** 3 rewrites of a text block's HTML, same tags and styles, same personal tags. */
export async function rewriteText(input: { html: string; action: RewriteAction; instruction?: string; context?: string }): Promise<string[]> {
  const ask = input.action === "custom" ? str(input.instruction, 500) : ACTION_ASK[input.action];
  if (!ask) throw new Error("Say how to change it");
  if (!words(input.html)) throw new Error("This block has no words yet");
  const j = await askJson(
    `You edit the words of one text block of a CARBON marketing email. ${VOICE}
Keep EXACTLY the same HTML structure: the same elements in the same order with the same tag names and the same style attributes; only the words inside change (bold/italic/link tags may move with the words they belong to; keep every href). Keep every personal tag in double curly braces exactly as written. Keep prices, product names and the store's facts exactly.
Answer JSON: {"options": ["<html>", "<html>", "<html>"]} — three different versions${input.action === "fix" ? " (for a spelling fix the three may be the same)" : ""}.`,
    `THE CHANGE: ${ask}\n${input.context ? `THE REST OF THE EMAIL (for context only, do not rewrite it):\n${input.context.slice(0, 3000)}\n` : ""}\nTHE BLOCK'S HTML:\n${input.html}`,
  );
  const want = tagsIn(input.html).join(",");
  const opts = (Array.isArray(j.options) ? j.options : [])
    .map((o) => cleanHtml(str(o, 8000)))
    .filter((o) => words(o) && tagsIn(o).join(",") === want);
  if (!opts.length) throw new Error("The AI answer could not be used. Try again.");
  return [...new Set(opts)].slice(0, 3);
}

/** The words of the whole email, block by block, with ids (for subject lines and the check). */
export function emailText(doc: EmailDoc): { id: string; kind: string; text: string }[] {
  const out: { id: string; kind: string; text: string }[] = [];
  const add = (id: string, kind: string, text: string) => text.trim() && out.push({ id, kind, text: text.trim().slice(0, 1200) });
  for (const s of doc.sections)
    for (const c of s.cols)
      for (const b of c.blocks) {
        if (b.type === "text") add(b.id, "text", words(b.html));
        else if (b.type === "button") add(b.id, "button", b.text);
        else if (b.type === "image") add(b.id, "picture alt text", b.alt);
        else if (b.type === "split") add(b.id, "photo and text", b.cells.map((x) => (x.kind === "text" ? words(x.html) : "")).join(" "));
        else if (b.type === "code") add(b.id, "code box", `${b.title} / ${b.note} / ${b.button ? b.buttonText : ""}`);
        else if (b.type === "product") add(b.id, "products", b.items.slice(0, 12).map((p) => `${p.title} $${p.price}`).join("; "));
      }
  return out;
}

export type SubjectIdea = { subject: string; preheader: string };

export async function subjectLines(doc: EmailDoc, hint?: string): Promise<SubjectIdea[]> {
  const text = emailText(doc)
    .filter((x) => x.kind !== "picture alt text")
    .map((x) => `- ${x.text}`)
    .join("\n");
  if (!text) throw new Error("Write the email first: there are no words to go on yet");
  const j = await askJson(
    `You write inbox lines for one CARBON marketing email. ${VOICE}
Write 6 different pairs: a subject line (30–55 characters, no ALL CAPS words except CARBON, at most one emoji and only if it truly fits, no spammy words like "FREE!!!", "act now", "$$$") and preview text (the grey line after the subject, 40–90 characters, adds something new instead of repeating the subject). Mix the angles: curiosity, the product, the person's own offer (only if the email has a code box: then you may use {{offer_amount}}), the store, the season. You may use {{first_name|there}} in at most two of them.
Answer JSON: {"ideas": [{"subject": "...", "preheader": "..."}]}`,
    `${hint ? `THE OWNER'S NOTE: ${hint}\n` : ""}THE EMAIL'S WORDS:\n${text.slice(0, 5000)}`,
  );
  const ok = new Set<string>(MERGE_TAGS);
  const ideas = (Array.isArray(j.ideas) ? j.ideas : [])
    .map((x) => ({ subject: str((x as Record<string, unknown>).subject, 120), preheader: str((x as Record<string, unknown>).preheader, 160) }))
    .filter((x) => x.subject && tagsIn(x.subject + x.preheader).every((t) => ok.has(t)));
  if (!ideas.length) throw new Error("The AI answer could not be used. Try again.");
  return ideas.slice(0, 6);
}

/* ---------------------------------------------------------- check before sending */

export type CheckIssue = { level: "fix" | "tip"; blockId: string | null; text: string };

/** The fixed rules (no AI, instant). */
export function ruleIssues(doc: EmailDoc, subject: string, preheader: string): CheckIssue[] {
  const out: CheckIssue[] = [];
  const known = new Set<string>(MERGE_TAGS);
  if (!subject.trim()) out.push({ level: "fix", blockId: null, text: "There is no subject line (Subject line and preview text, on the left)." });
  else if (subject.length > 70) out.push({ level: "tip", blockId: null, text: `The subject line is ${subject.length} characters; phones cut it after about 40–60.` });
  if (!preheader.trim()) out.push({ level: "tip", blockId: null, text: "There is no preview text: inboxes will show the first words of the email instead." });
  const badLink = (h: string) => !h.trim() || h.trim() === "#" || !/^(https?:\/\/|mailto:|tel:|\{\{)/i.test(h.trim());
  for (const t of tagsIn(subject + " " + preheader)) if (!known.has(t)) out.push({ level: "fix", blockId: null, text: `Unknown personal tag {{${t}}} in the subject or preview text.` });
  let images = 0;
  let words_ = 0;
  for (const s of doc.sections)
    for (const c of s.cols)
      for (const b of c.blocks) {
        const tags = (txt: string) => {
          for (const t of tagsIn(txt)) if (!known.has(t)) out.push({ level: "fix", blockId: b.id, text: `Unknown personal tag {{${t}}}: it would be sent as written.` });
        };
        if (b.type === "text") {
          tags(b.html);
          words_ += words(b.html).split(/\s+/).length;
          for (const m of b.html.matchAll(/href="([^"]*)"/g)) if (badLink(m[1])) out.push({ level: "fix", blockId: b.id, text: `A link in this text goes nowhere ("${m[1] || "empty"}").` });
          if (/lorem ipsum|one line about|two or three sentences|a short headline|look name|one line on how/i.test(words(b.html)))
            out.push({ level: "fix", blockId: b.id, text: `This text is still the example wording: "${words(b.html).slice(0, 60)}…"` });
        } else if (b.type === "image") {
          images++;
          if (!b.src) out.push({ level: "fix", blockId: b.id, text: "This picture spot is empty (it will not show in the email)." });
          else if (!b.alt.trim()) out.push({ level: "tip", blockId: b.id, text: "This picture has no alt text: many inboxes hide pictures until the person allows them, and then the alt text is all they see." });
          if (b.href && badLink(b.href)) out.push({ level: "fix", blockId: b.id, text: `This picture's link goes nowhere ("${b.href}").` });
        } else if (b.type === "button") {
          if (badLink(b.href)) out.push({ level: "fix", blockId: b.id, text: `The "${b.text}" button has no working link.` });
          tags(b.text);
        } else if (b.type === "product") {
          if (b.source === "static" && !b.items.length) out.push({ level: "fix", blockId: b.id, text: "This product block has no products picked." });
        } else if (b.type === "split") {
          for (const x of b.cells) if (x.kind === "image" && !x.src) out.push({ level: "fix", blockId: b.id, text: "The photo side of this block is empty." });
        } else if (b.type === "code") {
          tags(`${b.title} ${b.note}`);
        } else if (b.type === "video") {
          if (!b.thumb || badLink(b.href)) out.push({ level: "fix", blockId: b.id, text: "This video block needs a thumbnail picture and a link." });
        }
      }
  if (images > 0 && words_ < 25) out.push({ level: "tip", blockId: null, text: "The email is almost all pictures and very few words: spam filters and people with pictures off see little." });
  return out;
}

/** The fixed rules plus the AI's read of the words. */
export async function checkEmail(doc: EmailDoc, subject: string, preheader: string): Promise<CheckIssue[]> {
  const rules = ruleIssues(doc, subject, preheader);
  const text = emailText(doc);
  if (!text.length) return rules;
  const ids = new Set(text.map((x) => x.id));
  const j = await askJson(
    `You proofread one CARBON marketing email before it is sent to customers. ${VOICE}
Report only real problems a careful editor would fix: spelling and grammar mistakes, an invented discount/percentage/date/free gift (anything not written as a personal tag), another brand's name or "Carbon Jeans", an em dash, a hype word, a claim the store cannot back up, words that contradict each other (two different prices for the same thing, "today only" next to a date), a subject line that does not match the email. Do not comment on design, layout or pictures. Do not invent problems: if the words are fine, return an empty list. Personal tags in double curly braces are filled in per person and are not mistakes.
Answer JSON: {"issues": [{"id": "<block id, or null for the subject/preview text>", "level": "fix" | "tip", "text": "the problem and the fix, one short plain sentence"}]}`,
    `SUBJECT: ${subject || "(none)"}\nPREVIEW TEXT: ${preheader || "(none)"}\n\nTHE EMAIL, BLOCK BY BLOCK (id | kind | words):\n${text.map((x) => `${x.id} | ${x.kind} | ${x.text.replace(/\n+/g, " / ")}`).join("\n").slice(0, 9000)}`,
  );
  const ai = (Array.isArray(j.issues) ? j.issues : [])
    .map((x) => x as Record<string, unknown>)
    .map((x) => ({ level: (x.level === "fix" ? "fix" : "tip") as CheckIssue["level"], blockId: typeof x.id === "string" && ids.has(x.id) ? x.id : null, text: str(x.text, 300) }))
    .filter((x) => x.text)
    .slice(0, 20);
  return [...rules, ...ai];
}

/* ------------------------------------------------------------- write a whole email */

/** Sections the AI may use, with what each one is for. The fixed ones keep their own words. */
const PARTS: Record<string, string> = {
  announce: "black bar at the very top: free shipping over $125 (fixed words)",
  header: "logo + WOMEN / MEN / NEW IN links on white (fixed)",
  "header-dark": "the same logo header on black (fixed)",
  hero: "big photo, headline, one line, button (light)",
  "hero-dark": "small label, headline, big photo, button on black",
  "hero-editorial": "small label, big italic Bodoni headline, one line, photo, button on cream: elegant",
  drop: "small mono label, huge Bebas headline, photo, full-width neon button on black: streetwear drop",
  signature: "a short personal note in a serif + 'With love, Carbon' in script",
  headline: "a headline and 2–3 sentences",
  "products-3": "a small title and 3 products in a row (with buttons)",
  "products-6": "a small title, 6 products (2 rows of 3) and a button",
  look: "one outfit: its photo on the left, look name + one line + its pieces on the right",
  split: "a photo beside a short text",
  "two-photos": "two photos side by side",
  code: "the person's own discount code box (only when the owner asks for an offer or code)",
  store: "the Orlando showroom: photos, address, hours, directions (fixed facts; its headline may change)",
  follow: "follow @shopcarbon with social icons (fixed)",
};
const FIXED_TEXT = new Set(["announce", "header", "header-dark", "follow"]);
const STORE_FIXED_AFTER_FIRST = "store";

type Slot =
  | { kind: "text"; key: string; blockId: string; index: number; tag: string; current: string }
  | { kind: "button"; key: string; blockId: string; current: string }
  | { kind: "image"; key: string; blockId: string; cell?: number }
  | { kind: "products"; key: string; blockId: string; count: number };

const TOP_EL = /<(h1|h2|h3|h4|p)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;

/** The fillable spots of a pre-built section, in order (T1, T2 … B1 … I1 … G1 …). */
function slotsOf(partId: string, sections: Section[]): Slot[] {
  const out: Slot[] = [];
  let t = 0;
  let bt = 0;
  let im = 0;
  let g = 0;
  const fixed = FIXED_TEXT.has(partId);
  for (const s of sections)
    for (const c of s.cols)
      for (const b of c.blocks) {
        if (b.type === "text" && !fixed) {
          let i = 0;
          for (const m of b.html.matchAll(TOP_EL)) {
            // The store keeps its address/hours lines; only its first headline is writable.
            if (!(partId === STORE_FIXED_AFTER_FIRST && (t > 0 || m[1].toLowerCase() === "p"))) out.push({ kind: "text", key: `T${++t}`, blockId: b.id, index: i, tag: m[1].toLowerCase(), current: words(m[3]) });
            i++;
          }
        } else if (b.type === "button" && !fixed && partId !== "store") out.push({ kind: "button", key: `B${++bt}`, blockId: b.id, current: b.text });
        else if (b.type === "image" && !b.src) out.push({ kind: "image", key: `I${++im}`, blockId: b.id });
        else if (b.type === "split") {
          b.cells.forEach((x, ci) => x.kind === "image" && !x.src && out.push({ kind: "image", key: `I${++im}`, blockId: b.id, cell: ci }));
          b.cells.forEach((x, ci) => {
            if (x.kind !== "text") return;
            let i = 0;
            for (const m of x.html.matchAll(TOP_EL)) out.push({ kind: "text", key: `T${++t}`, blockId: `${b.id}#${ci}`, index: i++, tag: m[1].toLowerCase(), current: words(m[3]) });
          });
        } else if (b.type === "product") out.push({ kind: "products", key: `G${++g}`, blockId: b.id, count: b.source === "static" ? 3 : b.perRow * b.rows });
      }
  return out;
}

function describePart(id: string): string {
  const slots = slotsOf(id, prebuiltSections(id));
  const list = slots
    .map((s) =>
      s.kind === "text"
        ? `${s.key} (${s.tag}, now "${s.current.slice(0, 50)}")`
        : s.kind === "button"
          ? `${s.key} (button, now "${s.current}")`
          : s.kind === "image"
            ? `${s.key} (photo: one product ref)`
            : `${s.key} (products: ${s.count === 3 && id === "look" ? "the look's 2–4 pieces" : `${s.count} product refs`})`,
    )
    .join(", ");
  return `${id}: ${PARTS[id]}${list ? ` — spots: ${list}` : ""}`;
}

/** Put plain words into the n-th top-level element of some HTML, keeping its tag and style. */
function setElementText(html: string, index: number, text: string): string {
  let i = 0;
  return html.replace(TOP_EL, (whole, tag: string, attrs: string | undefined, inner: string) => {
    if (i++ !== index) return whole;
    const safe = escText(text).replace(/\n/g, "<br>");
    const strong = /^\s*<strong>[\s\S]*<\/strong>\s*$/i.test(inner);
    return `<${tag}${attrs ?? ""}>${strong ? `<strong>${safe}</strong>` : safe}</${tag}>`;
  });
}

const LINKS: Record<string, string> = {
  shop: "https://shopcarbon.com",
  women: "https://shopcarbon.com/collections/women",
  men: "https://shopcarbon.com/collections/men",
  new: "https://shopcarbon.com/collections/new-arrivals",
};

type Pick = { item: ProductItem; image: string | null; url: string };

function itemFor(ref: string, byRef: Map<string, CatalogProduct>, sets: Map<string, CatalogSet>): Pick | null {
  const p = byRef.get(ref);
  if (p) return { item: { id: p.id, title: p.title, price: p.price, compareAt: p.compareAt, image: p.image, url: p.url, set: null }, image: p.image, url: p.url };
  const s = sets.get(ref);
  if (s)
    return {
      item: { id: `set:${s.lead.id}`, title: s.name, price: s.total, compareAt: null, image: s.lead.image, url: s.lead.url, set: { line: s.piecesLine, total: s.total, pieces: s.pieces.length } },
      image: s.lead.image,
      url: s.lead.url,
    };
  return null;
}

export type BuiltEmail = { doc: EmailDoc; title: string; subject: string; preheader: string };

/** "Write it with AI": one text call → a whole email from the pre-built sections. */
export async function buildFromBrief(brief: string, kit: { styles: GlobalStyles } | null): Promise<BuiltEmail> {
  const ask = brief.trim().slice(0, 2000);
  if (ask.length < 6) throw new Error("Say in a sentence or two what the email is about");
  const items = await inStockCatalog();
  if (!items.length) throw new Error("The catalog could not be loaded. Try again in a minute.");
  const sets = catalogSets(items);
  const usable = Object.keys(PARTS).filter((id) => PREBUILT.some((p) => p.id === id));
  const j = await askJson(
    `You plan and write one CARBON marketing email inside a drag-and-drop editor, using ready-made sections. ${VOICE}
${STORE_TEXT}

Choose the look: "light" (white page) or "dark" (black page, streetwear). Then choose 4–9 sections in order from the list below and fill their spots:
- text spots: the words only (plain text, no HTML; \\n for a line break). A label/kicker stays short and in capitals; headlines 2–6 words; paragraphs 1–3 short sentences.
- button spots: {"text": "SHORT CAPS LABEL", "link": "shop" | "women" | "men" | "new" | "<product ref>"}.
- photo spots: one product ref (its catalog photo is used; pick a product whose photo suits the spot: a full outfit for a hero).
- product spots: a list of product refs (real refs from the CATALOG only; prefer stock 3+; a matching set X-ref counts as one card).
Always start with a header (or the announce bar then a header); with the dark look use "header-dark". End with "follow". Use "code" only when the owner asks for an offer, a discount or a code. Use "store" when the store or a visit fits. Never repeat the same product in two spots unless the owner asks. Match the owner's ask (women / men / a category / a season / an event).

SECTIONS:
${usable.map(describePart).join("\n")}

Answer JSON: {"title": "short internal name", "subject": "30–55 characters", "preheader": "40–90 characters", "look": "light" | "dark", "sections": [{"id": "<section id>", "spots": {"T1": "...", "B1": {"text": "...", "link": "..."}, "I1": "P12", "G1": ["P3", "X2"]}}]}`,
    `THE OWNER'S ASK: ${ask}\n\nCATALOG (in stock, newest first) — ref | title | type | gender | colours | price | stock:\n${catalogLines(items, sets).slice(0, 40000)}`,
  );
  return assembleEmail(j, items, sets, kit);
}

/** The AI's plan → the email (pure; tested in scripts/test-email-editor.ts). */
export function assembleEmail(j: Record<string, unknown>, items: CatalogProduct[], sets: CatalogSet[], kit: { styles: GlobalStyles } | null): BuiltEmail {
  const usable = Object.keys(PARTS).filter((id) => PREBUILT.some((p) => p.id === id));
  const byRef = new Map(items.map((p) => [p.ref, p]));
  const setsByRef = new Map(sets.map((s) => [s.ref, s]));
  const dark = j.look === "dark";
  const plan = (Array.isArray(j.sections) ? j.sections : []).map((x) => x as Record<string, unknown>).filter((x) => typeof x.id === "string" && usable.includes(x.id as string));
  if (plan.length < 2) throw new Error("The AI answer could not be used. Try again.");

  const sections: Section[] = [];
  for (const part of plan) {
    let id = part.id as string;
    if (dark && id === "header") id = "header-dark";
    const secs = prebuiltSections(id);
    const spots = (part.spots && typeof part.spots === "object" ? part.spots : {}) as Record<string, unknown>;
    const slots = slotsOf(id, secs);
    const blocks = new Map<string, Block>();
    for (const s of secs) for (const c of s.cols) for (const b of c.blocks) blocks.set(b.id, b);
    for (const slot of slots) {
      const v = spots[slot.key];
      if (v == null) continue;
      if (slot.kind === "text") {
        const text = str(v, 600);
        if (!text) continue;
        const [bid, cell] = slot.blockId.split("#");
        const b = blocks.get(bid);
        if (b?.type === "text") b.html = setElementText(b.html, slot.index, text);
        else if (b?.type === "split" && cell != null) {
          const x = b.cells[Number(cell)];
          if (x?.kind === "text") x.html = setElementText(x.html, slot.index, text);
        }
      } else if (slot.kind === "button") {
        const b = blocks.get(slot.blockId);
        const o = (typeof v === "object" ? v : { text: v }) as Record<string, unknown>;
        if (b?.type !== "button") continue;
        const text = str(o.text, 40);
        if (text) b.text = text;
        const link = str(o.link, 40);
        b.href = LINKS[link] ?? itemFor(link, byRef, setsByRef)?.url ?? b.href;
      } else if (slot.kind === "image") {
        const pick = itemFor(str(v, 12), byRef, setsByRef);
        if (!pick?.image) continue;
        const b = blocks.get(slot.blockId);
        if (b?.type === "image") {
          b.src = pick.image;
          b.alt = pick.item.title;
          b.href = pick.url;
        } else if (b?.type === "split" && slot.cell != null) {
          const x = b.cells[slot.cell];
          if (x?.kind === "image") b.cells[slot.cell] = { ...x, src: pick.image, alt: pick.item.title, href: pick.url };
        }
      } else if (slot.kind === "products") {
        const refs = (Array.isArray(v) ? v : []).map((r) => str(r, 12));
        const picked = refs.map((r) => itemFor(r, byRef, setsByRef)).filter((x): x is Pick => !!x);
        const b = blocks.get(slot.blockId);
        if (b?.type !== "product" || !picked.length) continue;
        b.source = "static";
        b.items = picked.slice(0, 12).map((x) => x.item);
        if (id !== "look") {
          b.perRow = Math.min(3, b.items.length);
          b.rows = Math.ceil(b.items.length / b.perRow);
        }
      }
    }
    sections.push(...secs);
  }
  let doc: EmailDoc = { v: 1, styles: kit && !dark ? kit.styles : defaultStyles(), sections };
  if (dark) doc = darkenDoc(doc);
  return {
    doc,
    title: str(j.title, 80) || "AI email",
    subject: str(j.subject, 120),
    preheader: str(j.preheader, 160),
  };
}
