/**
 * CarbonWMS Email — a different style every time (owner, 2026-11-08: "every time I generate an email it
 * should generate a new different style, not the same, the same, the same").
 *
 * A style = a page STRUCTURE × a TYPE treatment × a COLOUR scheme. Every new AI version (and each of the
 * three directions) gets its own combination, chosen at random among the ones NOT used in the store's
 * recent emails (all designs), and the three directions of one message always get three different
 * structures, type treatments and colour schemes. Small edits keep the current version's style.
 */
import { randomInt } from "node:crypto";
import type { Pool } from "pg";

export type Style = { structure: string; type: string; colour: string };

export const STRUCTURES: Record<string, string> = {
  "hero-three-looks":
    "HERO + THREE LOOKS: one full-width hero photo on top, the headline under it; then three outfit rows — the look photo on one side, its pieces with names and prices on the other, alternating sides; a slim offer strip; the store last.",
  "mosaic":
    "MOSAIC, NO HERO ON TOP: open with the headline in huge type on a solid colour block; then an asymmetric grid where the hero, the look photos and product tiles interlock in different sizes (one large + two small, then two + one); the offer as a tag inside the grid; the store as a compact card.",
  "story-scroll":
    "STORY SCROLL: a vertical run of tall full-width photos like phone stories (hero, then each look), each with one short line of copy and a small row of the pieces worn beneath; the offer as its own story; the store as the final story with directions.",
  "letter":
    "THE LETTER: opens with a short personal note from the Orlando store in plain type (no photo), then ONE big hero photo, then the three looks as a tidy two-column grid, then the store.",
  "price-list":
    "PRICE LIST: a printed-catalogue look — the hero as a wide strip, then numbered rows (01, 02 …) with small product tiles, names and prices like a menu, each look's photo as a divider between groups, the store at the end.",
  "split-screen":
    "SPLIT SCREEN: every section is two equal halves side by side (photo | text, text | photo, tile | tile), dark and light halves alternating like a checkerboard down the email.",
  "magazine-cover":
    "MAGAZINE COVER: the hero photo fills the first screen with the headline set over its quiet side like a magazine cover line; then a contents-style list of the three looks (01 / 02 / 03), then each look as a two-column editorial spread.",
  "numbered-lookbook":
    "NUMBERED LOOKBOOK: huge outlined numbers 01, 02, 03 lead each look; each look is a big photo with a caption block and its pieces listed underneath; the hero is a slim banner between the intro and look 01.",
  "streetwear-zine":
    "STREETWEAR ZINE: a ticker strip with repeated words at the top, stamped labels, coordinates and dates as graphic details, photos cropped at angles of 90° only (no rotation), product tiles on a light grid, a bold sticker-style offer block.",
  "the-drop":
    "THE DROP: a release header (\"DROP 01 · AW2026\") with date and time, the hero as a wide teaser, then the looks as 'pieces in the drop' cards with a small 'IN STOCK' tag, a countdown-style offer block, the store as the pick-up point.",
  "city-guide":
    "CITY GUIDE: Orlando-led — opens with the store and a short 'where to wear it' intro, then each look as a stop on a walk through the city (photo + a one-line place description + pieces), ending with directions.",
  "quiet-luxury":
    "QUIET LUXURY: lots of white space, one photo per screen, small centred headings, very few words; the pieces listed in fine type under each photo; the offer as one elegant line.",
  "polaroid-wall":
    "PHOTO WALL: the hero and look photos shown as framed prints with thin borders and handwritten-style captions in a loose two-column wall, product names and prices under each print; the offer as a pinned note.",
  "big-type":
    "BIG TYPE: giant headline words fill the width between photos (one or two words per line), the photos sit between the words full width, the pieces in a compact list after each look.",
};

export const TYPES: Record<string, string> = {
  "condensed-caps": "bold condensed sans-serif in capitals, tight letter-spacing, big contrast between huge headings and small body text",
  "editorial-serif": "elegant high-contrast serif headings (Didone feel) with a clean sans-serif body, sentence case",
  "technical-mono": "monospaced labels and numbers (spec-sheet feel) with a plain sans-serif body",
  "wide-grotesk": "wide geometric sans-serif headings with generous letter-spacing, light weights",
  "outlined-numbers": "oversized outlined numerals and words as graphic elements, bold sans-serif body",
  "mixed-weights": "headlines that mix a very bold word with a thin one, sans-serif throughout",
};

export const COLOURS: Record<string, string> = {
  "black-white": "black and white with plenty of white space",
  "cream-espresso": "warm cream background with espresso brown and black text",
  "after-dark": "the whole email on black or charcoal with white text and one sharp accent colour",
  "campaign-blocks": "full-width colour blocks in the campaign palette alternating behind sections",
  "stone-olive": "stone grey with deep olive and off-white",
  "navy-sand": "deep navy with sand and white",
  "monochrome-red": "black, white and one strong red accent used sparingly",
};

const pick = <T>(list: T[]): T => list[randomInt(list.length)];

/**
 * n styles for a new message (owner's rule, 2026-11-08):
 *  - a style used in an email that was actually SENT in the last 14 days is not used again;
 *  - in THIS design, every style already shown (chosen or not) is not repeated when the owner asks
 *    for another version or 3 more directions;
 *  - the n styles of one message all differ from each other;
 *  - unsent drafts in other designs do not limit anything.
 * When the library runs out, the oldest-used options come back first — never the exact same
 * structure + type + colours as one already shown in this design.
 */
export async function freshStyles(pool: Pool, tenantId: string, designId: string, n: number): Promise<Style[]> {
  const sent = await pool.query<{ style: Style }>(
    `SELECT m.style FROM email_campaigns c JOIN email_designs d ON d.id = c.design_id JOIN email_design_messages m ON m.id = d.chosen_message
      WHERE c.tenant_id = $1::uuid AND c.started_at > now() - interval '14 days' AND m.style IS NOT NULL`,
    [tenantId],
  );
  const shown = await pool.query<{ style: Style }>(
    `SELECT style FROM email_design_messages WHERE design_id = $1::uuid AND role = 'ai' AND style IS NOT NULL ORDER BY created_at DESC`,
    [designId],
  );
  const blocked = [...sent.rows.map((r) => r.style), ...shown.rows.map((r) => r.style)];
  const combos = new Set(shown.rows.map((r) => `${r.style.structure}|${r.style.type}|${r.style.colour}`));
  const out: Style[] = [];
  // Options not blocked and not taken by this message; if none is left, the ones blocked longest ago.
  const choose = (key: keyof Style, keys: string[]) => {
    const taken = new Set(out.map((s) => s[key]));
    const free = keys.filter((k) => !taken.has(k) && !blocked.some((b) => b[key] === k));
    if (free.length) return pick(free);
    const order = [...blocked].reverse().map((b) => b[key]); // oldest first
    const notTaken = keys.filter((k) => !taken.has(k));
    return notTaken.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? pick(keys);
  };
  for (let i = 0; i < n; i++) {
    let s: Style = { structure: "", type: "", colour: "" };
    for (let tries = 0; tries < 12; tries++) {
      s = { structure: choose("structure", Object.keys(STRUCTURES)), type: choose("type", Object.keys(TYPES)), colour: choose("colour", Object.keys(COLOURS)) };
      if (!combos.has(`${s.structure}|${s.type}|${s.colour}`)) break;
    }
    out.push(s);
  }
  return out;
}

export function styleBrief(s: Style): string {
  return [`PAGE STRUCTURE — ${STRUCTURES[s.structure] ?? s.structure}`, `TYPE — ${TYPES[s.type] ?? s.type}.`, `COLOURS — ${COLOURS[s.colour] ?? s.colour}.`].join("\n");
}

/** The style in a few words (shown to the owner). */
export function styleName(s: Style): string {
  const t = (k: string) => k.replace(/-/g, " ");
  return `${t(s.structure)} · ${t(s.type)} · ${t(s.colour)}`;
}
