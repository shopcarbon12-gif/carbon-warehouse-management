/**
 * Radar — the strict category filter (spec §4.1). Clothing + shoes only.
 *   1. advertiser prior       (seed brands are apparel / footwear)
 *   2. landing-page schema    (JSON-LD Product category, og:type, breadcrumbs)
 *   3. vision LLM JSON        ({product_category, is_clothing_or_footwear, confidence, items_visible[]})
 *   4. decision               keep ≥ 0.75 · review 0.5–0.75 · else reject (reason logged)
 *   5. mixed ads              kept only if the ADVERTISED product is clothing or footwear
 * A free text pre-check rejects obvious jewelry / eyewear / beauty ads before any paid call.
 */
import { ALLOW_CATEGORIES, APPAREL_WORDS, BLOCK_CATEGORIES, BLOCK_WORDS, OPTIONAL_CATEGORIES, type AdAnalysis } from "./taxonomy";

export type Decision = { status: "kept" | "review" | "rejected"; reason: string; confidence: number; category: string | null };

export function textPreCheck(text: string): { blocked: string | null; apparel: boolean } {
  const apparel = APPAREL_WORDS.test(text);
  for (const [cat, re] of Object.entries(BLOCK_WORDS)) if (re.test(text) && !apparel) return { blocked: cat, apparel };
  return { blocked: null, apparel };
}

export type LandingSignal = { apparel: boolean; blocked: string | null; text: string };

/** Fetch the landing page (plain HTTP, 8 s) and read its product schema / og / breadcrumbs. */
export async function landingSignal(url: string | null | undefined): Promise<LandingSignal | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; CarbonWMS-Radar/1.0)", Accept: "text/html" } });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 600_000);
    const parts: string[] = [];
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const walk = (o: unknown): void => {
          if (!o || typeof o !== "object") return;
          if (Array.isArray(o)) return o.forEach(walk);
          const x = o as Record<string, unknown>;
          const t = String(x["@type"] ?? "");
          if (/Product|BreadcrumbList|ListItem/i.test(t)) for (const k of ["category", "name", "description"]) if (typeof x[k] === "string") parts.push(x[k] as string);
          Object.values(x).forEach(walk);
        };
        walk(JSON.parse(m[1]));
      } catch {
        /* bad JSON-LD */
      }
    }
    for (const m of html.matchAll(/<meta[^>]+property=["'](og:type|og:title|product:category)["'][^>]+content=["']([^"']+)/gi)) parts.push(m[2]);
    const text = parts.join(" · ").slice(0, 1200);
    if (!text) return null;
    const pre = textPreCheck(text);
    return { apparel: pre.apparel, blocked: pre.blocked, text };
  } catch {
    return null;
  }
}

export function decide(
  a: Pick<AdAnalysis, "product_category" | "is_clothing_or_footwear" | "advertised_product_is_clothing_or_footwear" | "confidence">,
  ctx: { prior: string | null; landing: LandingSignal | null; optional: { bags: boolean; hats: boolean; belts: boolean } },
): Decision {
  const cat = a.product_category.toLowerCase().replace(/[^a-z_]/g, "_");
  let conf = a.confidence;
  if (ctx.prior === "apparel" || ctx.prior === "footwear") conf += 0.05;
  if (ctx.landing?.apparel) conf += 0.1;
  if (ctx.landing?.blocked) conf -= 0.3;
  conf = Math.max(0, Math.min(1, conf));
  if ((BLOCK_CATEGORIES as readonly string[]).includes(cat)) return { status: "rejected", reason: `blocked category: ${cat}`, confidence: conf, category: cat };
  if ((OPTIONAL_CATEGORIES as readonly string[]).includes(cat) && !ctx.optional[cat as keyof typeof ctx.optional])
    return { status: "rejected", reason: `${cat} are switched off (Settings → Radar)`, confidence: conf, category: cat };
  if (!a.advertised_product_is_clothing_or_footwear) return { status: "rejected", reason: `the advertised product is not clothing or footwear (${cat})`, confidence: conf, category: cat };
  if (!a.is_clothing_or_footwear) return { status: "rejected", reason: `not clothing or footwear (${cat})`, confidence: conf, category: cat };
  const allowed = (ALLOW_CATEGORIES as readonly string[]).includes(cat) || (OPTIONAL_CATEGORIES as readonly string[]).includes(cat);
  if (!allowed) return { status: conf >= 0.5 ? "review" : "rejected", reason: `unknown category "${cat}"`, confidence: conf, category: cat };
  if (conf >= 0.75) return { status: "kept", reason: `${cat} (${Math.round(conf * 100)}%)`, confidence: conf, category: cat };
  if (conf >= 0.5) return { status: "review", reason: `unsure: ${cat} at ${Math.round(conf * 100)}%`, confidence: conf, category: cat };
  return { status: "rejected", reason: `low confidence ${Math.round(conf * 100)}% (${cat})`, confidence: conf, category: cat };
}

export const ANALYSIS_PROMPT = (ad: { advertiser: string; headline: string; body: string; cta: string | null; landing: string | null; mediaKind: string; frames: number; transcript?: string | null }) =>
  [
    "You are tagging a competitor ad for a clothing brand's private inspiration library. Look at the pictures (for a video: keyframes in order) and the copy.",
    `Advertiser: ${ad.advertiser}`,
    `Headline: ${ad.headline || "—"}`,
    `Body: ${ad.body.slice(0, 1200) || "—"}`,
    `CTA: ${ad.cta ?? "—"}`,
    ad.landing ? `Landing page product info: ${ad.landing}` : "",
    `Media: ${ad.mediaKind}${ad.mediaKind === "video" ? `, ${ad.frames} keyframes in order` : ""}`,
    ad.transcript ? `Transcript: ${ad.transcript.slice(0, 1500)}` : "",
    "",
    "1) Category. product_category = the ADVERTISED product, exactly one of:",
    `   allowed: ${ALLOW_CATEGORIES.join(", ")}; optional: ${OPTIONAL_CATEGORIES.join(", ")}; blocked: ${BLOCK_CATEGORIES.join(", ")}.`,
    "   is_clothing_or_footwear = the main thing shown is a garment or shoe. advertised_product_is_clothing_or_footwear = what the ad SELLS is a garment or shoe (a model wearing jeans in a sunglasses ad → false).",
    "   confidence 0–1. items_visible = short names of what you see.",
    "2) Tags. media_type: static | carousel | video | ugc (creator-style, phone-shot, talking or try-on) | animated (motion graphics, kinetic type, cinemagraph, 3D/spins).",
    "   creative_pattern: 1–4 of material_detail_as_proof, routine_led_product_claim, pattern_interrupt, headline_claim, offer_and_value, feature_callout, before_after, try_on_haul, fit_check_mirror, styling_3_ways, outfit_grid, founder_story, customer_review_quote, comparison, unboxing, drop_countdown, lookbook_editorial, street_casting, slow_mo_fabric, size_inclusive_lineup, price_anchor, social_proof_numbers, seasonal_event — or a new snake_case pattern if none fits.",
    "   style_lane, gender, season_event, hook_text (the words or idea in the first 1.5 s), cta, offer, price_shown (exact text or null), palette (hex), background_type, model_count, typography_style.",
    "   video (null for stills): shot_list [{t seconds, shot}], cut_rate (cuts per second, estimate from keyframes), transitions used, music / voiceover / captions true|false|null.",
    "   structure_summary: the ad's structure in one or two sentences (hook → beats → payoff), in words that could be reused WITHOUT copying the brand, its logo, text or people.",
    "Never invent numbers you can't see. Return JSON only.",
  ]
    .filter(Boolean)
    .join("\n");
