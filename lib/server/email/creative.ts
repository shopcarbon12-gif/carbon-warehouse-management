/**
 * CarbonWMS Email — the creative director (owner, 2026-11-08: "a stronger
 * reasoning model like GPT-6 Astra creates the editorial concept, separate from
 * any HTML … and looks at the actual screenshots and calls out ugly layouts,
 * tiny text, bad crops").
 *
 * Two jobs, on the model chosen in Email → Settings (GPT-6 Astra by default,
 * gpt-5.5 to compare); if the chosen model is not available to the account the
 * call falls back to gpt-5.5 and says so:
 *   concept()  — step 1: the editorial idea of the email: one campaign hero,
 *                three looks with very different pictures, a simple offer and
 *                the showroom. No layout, no HTML.
 *   review()   — step 5: looks at the rendered desktop and phone screenshots
 *                and passes or fails them with concrete problems to fix.
 */
import type OpenAI from "openai";
import sharp from "sharp";
import { openai, textModel } from "./config";

type Part = OpenAI.Responses.ResponseInputContent;

export const img = (b: Buffer, detail: "low" | "high" | "auto" = "high"): Part => ({ type: "input_image", image_url: `data:image/jpeg;base64,${b.toString("base64")}`, detail });
export const txt = (text: string): Part => ({ type: "input_text", text });

/** A JSON answer from the creative model (falls back to gpt-5.5 when the chosen model is not available). */
export async function creativeJson(model: string, instructions: string, parts: Part[]): Promise<{ json: Record<string, unknown>; model: string }> {
  const ask = async (m: string) => {
    const r = await openai().responses.create({
      model: m,
      instructions,
      // json_object mode needs the word "json" in the input itself (instructions alone do not count).
      input: [{ role: "user", content: [...parts, txt("Answer with the JSON object described in your instructions.")] }],
      text: { format: { type: "json_object" } },
    });
    return JSON.parse(r.output_text || "{}") as Record<string, unknown>;
  };
  try {
    return { json: await ask(model), model };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const msg = e instanceof Error ? e.message : String(e);
    const unavailable = status === 404 || status === 403 || (status === 400 && /model/i.test(msg));
    if (!unavailable || model === textModel()) throw e;
    console.warn(`[email-creative] ${model} not available (${status}: ${msg.slice(0, 120)}); using ${textModel()}`);
    return { json: await ask(textModel()), model: `${textModel()} (${model} unavailable)` };
  }
}

/* ------------------------------------------------------------------- concept */

/** One person in a photo and their complete outfit (owner, 2026-11-08: approve each person's look in its own row). */
export type Person = { who: string; products: string[] };
/** products = every piece in the photo (all people together). */
export type Look = { id: string; name: string; scene: string; mood: string; products: string[]; copy: string; people: Person[] };
export type Concept = {
  story: string;
  photo_style: string;
  hero: { scene: string; products: string[]; headline: string; people: Person[] };
  looks: Look[];
  offer: { headline: string; text: string };
  showroom: { headline: string; text: string };
};

export const PHOTO_STYLE = `PREMIUM FASHION EDITORIAL, ON THE STREET (the owner's choice, 2026-11-08): polished campaign photography — composed confident poses, controlled flattering light (golden hour or soft overcast daylight, gentle fill), a refined colour grade, crisp detail — but set on REAL Orlando streets and places (sidewalks, crosswalks, storefronts, palm-lined streets, parking decks, outdoor stairs, basketball courts), never empty studios, marble lobbies, gold doors or glossy wet nights. Real people: natural skin texture, real hands, believable proportions; new faces every time (never anyone from a reference photo).`;

export const CONCEPT_RULES = `You are the creative director of CARBON, an Orlando streetwear and going-out fashion store (men and women; store + shopcarbon.com). You write the EDITORIAL CONCEPT of one marketing email — the idea, the pictures and the words — never its layout or HTML (a designer does that next).

The shape of every CARBON email (unless the owner explicitly asks for something else):
1. ONE big campaign hero picture with a short headline.
2. THREE LOOKS — three complete outfits (top + bottom + outer layer where it fits + shoes; an accessory if the catalog has one), each with a VERY DIFFERENT picture: different place, time of day, mood, framing and person (e.g. a men's look on a sunny crosswalk, a women's look at golden hour on outdoor stairs, a two-person look in a parking deck at dusk). Not twenty items: customers find the rest when they click through.
3. A simple offer.
4. The Orlando showroom.

Photos: ${PHOTO_STYLE}

EVERY PERSON wears a COMPLETE outfit of real catalog pieces: top, bottom, an outer layer where it fits the season, shoes, and an accessory if the catalog has one. List each person separately ("people"), in the order they stand in the photo.

Rules: real in-stock catalog products only (refs from the CATALOG; a matching set is one X-ref), styled by season and the owner's ask, prefer stock 3+; each look built from DIFFERENT pieces (repeat a piece only if the catalog leaves no choice; the hero may combine pieces from the looks); never name a real venue, business, street or neighbourhood in a photo brief — describe the kind of place ("a palm-lined downtown sidewalk"); product names, prices and store facts exactly as given; colour words in the copy, look names and photo briefs must match each product's real colour as listed in the CATALOG — when a product lists several colours, use the FIRST one (that is the colour in its photo); never other brands; never write "Carbon Jeans"; never invent discounts or dates; the personal discount is shown as the customer's own code (the designer handles it). Copy voice: short, confident, warm, no hype words, no em dashes.

Answer JSON:
{"reply": "1-3 plain sentences to the owner about the idea (no hype)",
 "title": "2-5 word name of the email (first concept only, else null)",
 "subject": "subject line, max 60 chars, may use {{first_name}}",
 "preheader": "inbox preview, max 90 chars",
 "direction": "the concept in under 10 words",
 "change": "new" | "keep" | "update"   (keep = the current concept stays exactly as it is because the owner only asked for design / layout changes; update = small changes; new = a new idea),
 "story": "2-3 sentences: the idea and the feeling",
 "hero": {"scene": "the hero photo as a photographer's brief: who (how many people, age range, look), where in Orlando, light, camera, pose, mood, where empty space is left for the headline", "headline": "max 6 words", "people": [{"who": "e.g. man, late 20s, short dark hair", "products": ["P12", "P40", "P3", "P7"]}, …]},
 "looks": [ {"name": "short look name", "scene": "photographer's brief as above, VERY different from the other two looks and the hero", "mood": "3-5 words", "copy": "one short sentence", "people": [{"who": "…", "products": ["P12","X3","P9"]}]} × 3 ],
 "offer": {"headline": "max 6 words", "text": "one sentence; say 'your code' — never a number you were not given"},
 "showroom": {"headline": "max 6 words", "text": "one sentence"},
 "products": ["every catalog ref used above"]}`;

/** Make sure a concept has the shape we need (3 looks, strings everywhere). */
export function cleanConcept(j: Record<string, unknown>): Concept {
  const s = (v: unknown, n = 1500) => String(v ?? "").slice(0, n);
  const refs = (v: unknown, max = 6) => (Array.isArray(v) ? v.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[PX]\d+$/.test(x)).slice(0, max) : []);
  const people = (o: Record<string, unknown>): Person[] => {
    const list = (Array.isArray(o.people) ? o.people : []).slice(0, 4).map((x) => {
      const q = (x ?? {}) as Record<string, unknown>;
      return { who: s(q.who, 120) || "person", products: refs(q.products, 7) };
    });
    // Older answers without "people": one person wearing everything listed.
    return list.length ? list : refs(o.products).length ? [{ who: "person", products: refs(o.products) }] : [];
  };
  const union = (ps: Person[]) => [...new Set(ps.flatMap((x) => x.products))];
  const hero = (j.hero ?? {}) as Record<string, unknown>;
  const heroPeople = people(hero);
  const looks = (Array.isArray(j.looks) ? j.looks : []).slice(0, 3).map((l, i) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const ps = people(o);
    return { id: `l${i + 1}`, name: s(o.name, 80), scene: s(o.scene), mood: s(o.mood, 80), products: union(ps), copy: s(o.copy, 300), people: ps };
  });
  const offer = (j.offer ?? {}) as Record<string, unknown>;
  const showroom = (j.showroom ?? {}) as Record<string, unknown>;
  return {
    story: s(j.story, 800),
    photo_style: PHOTO_STYLE,
    hero: { scene: s(hero.scene), products: union(heroPeople), headline: s(hero.headline, 80), people: heroPeople },
    looks,
    offer: { headline: s(offer.headline, 80), text: s(offer.text, 300) },
    showroom: { headline: s(showroom.headline, 80), text: s(showroom.text, 300) },
  };
}

/** The concept as the designer (and the owner) reads it, with product names instead of refs. */
export function conceptText(c: Concept, name: (ref: string) => string): string {
  const list = (r: string[]) => [...new Set(r.map(name))].join(", ");
  const who = (ps: Person[] | undefined, all: string[]) =>
    ps?.length ? ps.map((x, i) => `person ${i + 1} (${x.who}) wears ${list(x.products)}`).join("; ") : `wearing ${list(all)}`;
  return [
    `STORY: ${c.story}`,
    `HERO (campaign photo H1, headline "${c.hero.headline}"): ${c.hero.scene} — ${who(c.hero.people, c.hero.products)}`,
    ...c.looks.map((l, i) => `LOOK ${i + 1} "${l.name}" (photo L${i + 1}, mood: ${l.mood}): ${l.copy} — ${who(l.people, l.products)}. Photo: ${l.scene}`),
    `OFFER: "${c.offer.headline}" — ${c.offer.text}`,
    `SHOWROOM: "${c.showroom.headline}" — ${c.showroom.text}`,
  ].join("\n");
}

/* -------------------------------------------------------------------- review */

export type Issue = { severity: "high" | "medium" | "low"; view: "desktop" | "phone" | "both"; where: string; problem: string; fix: string };
export type Review = { pass: boolean; score: number; issues: Issue[]; summary: string; model: string };

const REVIEW_RULES = `You are CARBON's creative director doing the final visual check of a marketing email before it can be sent. You get the RENDERED email as screenshots: the desktop view (600 px email column) and the phone view (375 px), exactly as customers will see them, plus the facts it must show.

Fail the email for anything a customer would notice:
- ugly or unbalanced layout, awkward empty gaps, misaligned or uneven columns, cramped sections, too many items at once;
- text too small (phone body text under 14 px, desktop under 13 px), low contrast, text running into pictures or edges, broken line breaks;
- bad crops: heads, faces, feet or products cut off; a product shown too small to recognise; stretched or squashed pictures;
- missing or broken pictures, visible placeholder colour boxes (magenta, cyan, lime …), sample text left in;
- wrong product names or prices compared with the list; a matching set not shown as one card with its "Set $…" total;
- the logo missing, distorted, or on a background where it is hard to see;
- buttons too small to tap on the phone (under 44 px tall) or unclear;
- the phone view not re-flowed (tiny desktop layout squeezed).

Ignore the system footer at the very bottom (a thin line, then "You're getting this because…", Unsubscribe and the postal address): it is added by the sending system, fixed, and not part of the design.

Answer JSON: {"pass": true|false, "score": 1-10, "summary": "one sentence", "issues": [{"severity": "high|medium|low", "view": "desktop|phone|both", "where": "which section", "problem": "what is wrong", "fix": "exactly what to change in the HTML/CSS"}]}
pass = true only when there is no high-severity issue and the score is 7 or more.`;

async function screen(png: Buffer, width: number): Promise<Buffer> {
  return sharp(png).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

export async function review(model: string, shots: { desktop: Buffer; phone: Buffer }, facts: string): Promise<Review> {
  const { json, model: used } = await creativeJson(model, REVIEW_RULES, [
    txt(`FACTS the email must show correctly:\n${facts}`),
    txt("DESKTOP view (rendered):"),
    img(await screen(shots.desktop, 1200)),
    txt("PHONE view (rendered):"),
    img(await screen(shots.phone, 750)),
  ]);
  const issues = (Array.isArray(json.issues) ? json.issues : []).slice(0, 15).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const sev = o.severity === "high" || o.severity === "low" ? o.severity : "medium";
    const view = o.view === "desktop" || o.view === "phone" ? o.view : "both";
    return { severity: sev, view, where: String(o.where ?? "").slice(0, 120), problem: String(o.problem ?? "").slice(0, 400), fix: String(o.fix ?? "").slice(0, 400) } as Issue;
  });
  const score = Math.max(1, Math.min(10, Number(json.score) || 1));
  const pass = json.pass === true && score >= 7 && !issues.some((i) => i.severity === "high");
  return { pass, score, issues, summary: String(json.summary ?? "").slice(0, 300), model: used };
}

/* ----------------------------------------------------------------------- fix */

const FIX_RULES = `You fix a CARBON marketing email's HTML after a visual review. Return JSON {"html": "the complete corrected HTML document"}.
Keep everything that is not part of a listed problem exactly as it is: every <img> src, every link, every merge tag ({{…}}), all words, prices and names. Change only layout, sizes, spacing, alignment, crops (width/height of image boxes), colours for contrast, and phone @media rules, to fix the listed problems. Email-safe HTML only: tables, inline CSS, one <style> block in <head> for @media (max-width: 620px) rules, no scripts, no external CSS or fonts, no background images.`;

export async function fixHtml(html: string, issues: Issue[]): Promise<string> {
  const c = await openai().chat.completions.create({
    model: textModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: FIX_RULES },
      { role: "user", content: `PROBLEMS FOUND:\n${issues.map((i, n) => `${n + 1}. [${i.severity}, ${i.view}] ${i.where}: ${i.problem} → ${i.fix}`).join("\n")}\n\nTHE HTML:\n${html}` },
    ],
  });
  const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as { html?: string };
  if (!j.html || !/<table/i.test(j.html)) throw new Error("the fix did not return an email");
  return j.html;
}
