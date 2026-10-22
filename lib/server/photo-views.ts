/**
 * Which view a product photo shows (full-length front, close-up, back, …).
 * Shared by Bulk Studio › Upload (gallery order) and the Meta close-up feed.
 * Eight photos per low-detail call — a fraction of a cent per product.
 */
import type OpenAI from "openai";

export const PHOTO_VIEWS = ["full-front", "front-close", "side", "detail", "seated", "back-close", "back", "other"] as const;
export type PhotoView = (typeof PHOTO_VIEWS)[number];

/** Cache key for a photo: its URL without the query string. */
export const photoKey = (u: string) => u.split("?")[0];

const PROMPT = `Each photo is from a clothing store's product gallery. For each, give ONE label for the view it shows of the product:
- "full-front": FULL LENGTH facing the camera — the head AND the feet/shoes are both in the photo (or the whole garment laid flat)
- "front-close": the front, but cut off above the feet — waist up, torso, mid-thigh up, waist to knee, chest
- "side": FULL LENGTH (head and feet both in the photo) turned to the side or three-quarter
- "detail": a close-up of a label, fabric, neckline, hardware, print or stitching
- "seated": a person sitting
- "back-close": a back crop or over-the-shoulder back view (not full length)
- "back": the full-length back
- "other": anything else
JSON only: {"labels": ["...", ...]} in the same order as the photos.`;

/**
 * Labels `urls` (at most 8 per call, `parallel` calls at a time). A photo whose
 * call failed is left out of the result, so the caller can retry it later.
 */
export async function classifyPhotoViews(
  client: OpenAI,
  urls: string[],
  parallel = 8,
): Promise<Map<string, PhotoView>> {
  const out = new Map<string, PhotoView>();
  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += 8) batches.push(urls.slice(i, i + 8));
  for (let i = 0; i < batches.length; i += parallel) {
    await Promise.all(
      batches.slice(i, i + parallel).map(async (batch) => {
        try {
          const sized = batch.map((u) => (/cdn\.shopify\.com/.test(u) ? `${photoKey(u)}?width=512` : u));
          const c = await client.chat.completions.create({
            model: (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o",
            temperature: 0,
            max_tokens: 200,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: PROMPT },
                  ...sized.map((u) => ({ type: "image_url" as const, image_url: { url: u, detail: "low" as const } })),
                ],
              },
            ],
          });
          const labels = (JSON.parse(c.choices?.[0]?.message?.content || "{}") as { labels?: unknown[] }).labels ?? [];
          batch.forEach((u, k) =>
            out.set(photoKey(u), (PHOTO_VIEWS as readonly string[]).includes(String(labels[k])) ? (labels[k] as PhotoView) : "other"),
          );
        } catch {
          /* left unclassified */
        }
      }),
    );
  }
  return out;
}
