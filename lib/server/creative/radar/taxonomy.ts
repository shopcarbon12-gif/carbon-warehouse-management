/**
 * Radar — the brand seed list, keyword discovery terms, the strict category filter (spec §4.1)
 * and the tag vocabulary (spec §5). Editable lists live in the DB; these are the starting values.
 */
import { z } from "zod";

export type Lane = (typeof STYLE_LANES)[number];

export const SEED_BRANDS: { lane: string; prior: "apparel" | "footwear"; names: string[] }[] = [
  { lane: "streetwear", prior: "apparel", names: ["Represent", "Fear of God Essentials", "Kith", "Aimé Leon Dore", "Stüssy", "Corteiz", "Rhude", "Amiri", "Palm Angels", "Hellstar", "Trapstar", "Cole Buxton", "Godspeed", "mnml", "Purple Brand", "Ksubi"] },
  { lane: "denim", prior: "apparel", names: ["True Religion", "Rock Revival", "Diesel", "Levi's", "AGOLDE", "Good American", "Mavi", "AG Jeans", "Edwin"] },
  { lane: "luxury", prior: "apparel", names: ["Fear of God", "Rick Owens", "Off-White", "Alo", "Skims"] },
  { lane: "evening_going_out", prior: "apparel", names: ["House of CB", "Oh Polly", "Meshki", "Princess Polly", "Revolve", "Lulus", "Windsor", "Fashion Nova", "Edikted", "Bad Birdie"] },
  { lane: "basics_minimal", prior: "apparel", names: ["True Classic", "Quince", "Cuts", "Marine Layer", "Aviator Nation", "Buck Mason", "Taylor Stitch"] },
  { lane: "footwear", prior: "footwear", names: ["Nike", "New Balance", "Golden Goose", "Axel Arigato", "Common Projects", "On", "Steve Madden", "Rothy's", "Allbirds"] },
];

export const DISCOVERY_TERMS = [
  "streetwear", "denim", "jeans", "cargo pants", "hoodie", "graphic tee", "going out dress", "evening dress",
  "prom dress", "two piece set", "sneakers", "boots", "menswear", "womenswear",
];

export const ALLOW_CATEGORIES = [
  "tops", "hoodies_sweats", "outerwear", "denim", "pants_shorts_skirts", "dresses", "sets", "activewear", "basics_underwear", "swim", "footwear",
] as const;
export const OPTIONAL_CATEGORIES = ["bags", "hats", "belts"] as const;
export const BLOCK_CATEGORIES = [
  "jewelry", "watches", "eyewear", "beauty", "skincare", "fragrance", "hair", "home", "tech", "pets", "supplements", "kids_only", "other",
] as const;
export const PRODUCT_CATEGORIES = [...ALLOW_CATEGORIES, ...OPTIONAL_CATEGORIES, ...BLOCK_CATEGORIES] as const;

/** Words that mean a blocked category (for the free text pre-check + landing-page schema). */
export const BLOCK_WORDS: Record<string, RegExp> = {
  jewelry: /\b(jewel(le)?ry|necklace|bracelet|earrings?|rings?\b|pendant|diamond|gold chain|anklet)\b/i,
  watches: /\b(watch(es)?|timepiece|chronograph|smartwatch)\b/i,
  eyewear: /\b(sunglass(es)?|eyewear|eyeglass(es)?|glasses|lenses|frames)\b/i,
  beauty: /\b(makeup|lipstick|mascara|foundation|concealer|cosmetics?|nail polish|lashes)\b/i,
  skincare: /\b(skin ?care|serum|moisturi[sz]er|cleanser|spf|retinol|sunscreen)\b/i,
  fragrance: /\b(fragrance|perfume|cologne|eau de)\b/i,
  hair: /\b(shampoo|conditioner|hair (oil|care|dryer)|wig|extensions)\b/i,
  home: /\b(candle|bedding|sofa|furniture|decor|mattress|kitchen)\b/i,
  tech: /\b(phone case|headphones|earbuds|charger|laptop|speaker)\b/i,
  pets: /\b(dog|cat|pet) (food|toy|bed|collar)\b/i,
  supplements: /\b(supplement|protein powder|vitamins?|gummies|collagen)\b/i,
};
export const APPAREL_WORDS =
  /\b(jeans?|denim|hoodie|sweat(shirt|pants|suit)?|jacket|coat|tee|t-shirt|shirt|top|dress|skirt|shorts|pants|trousers|cargo|jogger|set|co-ord|leggings|bra|bodysuit|swim|bikini|sneakers?|shoes?|boots?|heels|sandals|loafers|trainers|outerwear|knit|cardigan|blazer|vest|corset|gown)\b/i;

export const MEDIA_TYPES = ["static", "carousel", "video", "ugc", "animated"] as const;
export const CREATIVE_PATTERNS = [
  "material_detail_as_proof", "routine_led_product_claim", "pattern_interrupt", "headline_claim", "offer_and_value", "feature_callout",
  "before_after", "try_on_haul", "fit_check_mirror", "styling_3_ways", "outfit_grid", "founder_story", "customer_review_quote", "comparison",
  "unboxing", "drop_countdown", "lookbook_editorial", "street_casting", "slow_mo_fabric", "size_inclusive_lineup", "price_anchor",
  "social_proof_numbers", "seasonal_event",
] as const;
export const STYLE_LANES = ["streetwear", "luxury", "evening_going_out", "denim", "basics_minimal", "athleisure", "workwear_utility", "y2k", "western"] as const;
export const SEASONS = ["bfcm", "holiday", "nye", "valentines", "spring_break", "summer", "back_to_school", "prom", "festival", "evergreen"] as const;

export const PATTERN_LABEL = (p: string) => p.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** One vision call does the category check AND the tags (cheaper than two). zod-validated. */
export const AdAnalysis = z.object({
  product_category: z.string(),
  is_clothing_or_footwear: z.boolean(),
  advertised_product_is_clothing_or_footwear: z.boolean(),
  confidence: z.number().min(0).max(1),
  items_visible: z.array(z.string()).max(12),
  media_type: z.enum(MEDIA_TYPES),
  creative_pattern: z.array(z.string()).max(4),
  style_lane: z.enum(STYLE_LANES),
  gender: z.enum(["men", "women", "unisex", "mixed"]),
  season_event: z.enum(SEASONS),
  hook_text: z.string().max(200),
  cta: z.string().max(60).nullable(),
  offer: z.string().max(120).nullable(),
  price_shown: z.string().max(40).nullable(),
  palette: z.array(z.string()).max(6),
  background_type: z.string().max(60),
  model_count: z.number().int().min(0).max(20),
  typography_style: z.string().max(80),
  video: z
    .object({
      shot_list: z.array(z.object({ t: z.number(), shot: z.string() })).max(20),
      cut_rate: z.number().nullable(),
      transitions: z.array(z.string()).max(8),
      music: z.boolean().nullable(),
      voiceover: z.boolean().nullable(),
      captions: z.boolean().nullable(),
    })
    .nullable(),
  structure_summary: z.string().max(400),
});
export type AdAnalysis = z.infer<typeof AdAnalysis>;
