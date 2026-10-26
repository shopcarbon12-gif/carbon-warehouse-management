/**
 * Alt text for every picture CARBON publishes (owner, 2026-10-26: "add it all
 * auto always"). One set of rules for the shop and for Social, built from the
 * SEO-audit / AI-search skills (describe what is there, the words people search,
 * no "image of", no stuffing) and the approved Product Copy Standard (the item,
 * its colour, how it is worn or shown; no claims the photo cannot show).
 *
 *   shop    — a product or collection photo on shopcarbon.com:
 *             "Gordon Hoodie Set in Turquoise – full-length front view"
 *   social  — a feed picture on Instagram: who wears what, where, and the
 *             words printed on the picture (screen readers read nothing else).
 */
import { claudeStructured, type ClaudeBlock } from "@/lib/server/claude";
import { claimRulesFor, findClaims } from "@/lib/seo/claims";
import { SEO_LIMITS } from "@/lib/seo/types";

export type AltImage = { id: string; url?: string; base64?: { mediaType: string; data: string } };

export const ALT_RULES = [
  "Write alt text: what a blind shopper needs to know about this picture, and what people type into Google Images.",
  "- Say only what is visible: the garment or garments, their colour, print or wash, and how they are shown (worn on a model, full-length front view, back view, close-up of the print, flat lay, styled outfit).",
  '- Use the product name once, naturally, when you are given it. Product labels you are given end with their colour ("Romeo Turtleneck Sweater Blue"): write the colour first, in lower case ("a blue Romeo Turtleneck Sweater"). Never invent product names, materials, sizes or prices.',
  '- Never start with "image of", "photo of", "picture of" or "a picture showing". No hashtags, no emoji, no calls to action, no exclamation marks.',
  "- No hype words (stylish, trendy, chic, elevate, perfect, must-have, stunning). Plain US English.",
  '- The brand is written "CARBON" (capitals). Never name another brand.',
  `- Keep it between ${SEO_LIMITS.altMin} and ${SEO_LIMITS.altMax} characters. Each picture gets its own text: say what makes this view different (front, back, side, detail).`,
].join("\n");

const SHOP_FORMAT =
  'Shop photos follow the store\'s format: "<Product name> in <Colour> – <what this photo shows>", e.g. "Gordon Hoodie Set in Turquoise – full-length front view" or "Dreamin Pants Set in Black – close-up of the silver coral print". 5 to 15 words.';
const SOCIAL_FORMAT =
  "Social pictures: one or two plain sentences. Name the models if you are told their names, what each wears (product names when given) and the setting in a few words. If a headline or words were added on top of the picture in the design, end with: Text reads <the words>. Lettering printed on the clothes or shoes is part of the product, never 'Text reads'. Up to 125 characters is the target; never more than 250.";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["alts"],
  properties: {
    alts: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "alt"], properties: { id: { type: "string" }, alt: { type: "string" } } },
    },
  },
} as const;

/**
 * Alt text for up to ~8 pictures of one product or one post, in one Claude call
 * (the pictures are seen together, so each view gets a different description).
 */
export async function writeAltTexts(input: {
  kind: "shop" | "social";
  images: AltImage[];
  productName?: string | null;
  colour?: string | null;
  /** Anything else known: tagged products, models' names, the words on the picture. */
  context?: string | null;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!input.images.length) return out;
  const content: ClaudeBlock[] = [];
  input.images.forEach((img, i) => {
    content.push({ type: "text", text: `Picture id ${i + 1}:` });
    content.push(
      img.base64
        ? { type: "image", source: { type: "base64", media_type: img.base64.mediaType, data: img.base64.data } }
        : { type: "image", source: { type: "url", url: String(img.url) } },
    );
  });
  const facts = [
    input.productName ? `Product: ${input.productName}` : "",
    input.colour ? `Colour: ${input.colour}` : "",
    input.context ? `Known: ${input.context}` : "",
  ].filter(Boolean);
  content.push({ type: "text", text: `${facts.join("\n") || "No product name given: describe the garments plainly."}\n\nReturn one alt text per picture id.` });
  const r = await claudeStructured<{ alts: { id: string; alt: string }[] }>({
    system: [ALT_RULES, input.kind === "shop" ? SHOP_FORMAT : SOCIAL_FORMAT, claimRulesFor({ productTitle: input.productName ?? "" })].join("\n\n"),
    content,
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "medium",
    maxTokens: 4000,
  });
  const max = input.kind === "shop" ? SEO_LIMITS.altMax : 250;
  for (const a of r.alts ?? []) {
    // Pictures are numbered 1..n in the request (long ids do not survive the round trip).
    const img = input.images[Number(String(a.id).replace(/\D/g, "")) - 1];
    if (!img) continue;
    let t = String(a.alt || "").replace(/\s+/g, " ").trim();
    // Alt text describes what is there, so words printed on a garment ("Summer Vibes") are facts:
    // only real claims (fabric, fit, feel, sizes) disqualify it, not the copy's cliché list.
    if (findClaims(t, { productTitle: input.productName ?? "" }).some((f) => f.kind !== "cliche")) continue;
    t = t.replace(/^(an? )?(image|photo|picture) (of|showing) /i, "");
    if (t.length > max) t = `${t.slice(0, max - 1).replace(/[\s,;:–-]+\S*$/, "")}.`;
    if (t.length >= SEO_LIMITS.altMin) out.set(img.id, t.charAt(0).toUpperCase() + t.slice(1));
  }
  return out;
}
