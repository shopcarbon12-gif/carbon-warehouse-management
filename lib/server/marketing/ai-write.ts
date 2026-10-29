/**
 * Social — "Write with AI" for a post (owner, 2026-10-25: AI captions).
 * Claude looks at the post's pictures (and an optional brief), writes the
 * title, caption and hashtags in CARBON's voice — taking the voice from the
 * brand's own recent captions — and names the products it can see, which are
 * then matched to the Meta catalog for Instagram product tags.
 *
 * Nothing is saved here: the screen fills the fields, the person edits and
 * saves, and the post still waits for approval.
 */
import type { Pool } from "pg";
import { claudeStructured, type ClaudeBlock } from "@/lib/server/claude";
import { COPY_RULES, TAG_PLACEMENT, pickCatalogProduct } from "./ai-changes";
import { searchCatalogProducts } from "./meta";
import { campaignIdentity } from "./campaign-identity";
import { videoFrames } from "./video-frames";
import type { MarketingPost } from "./store";

export type WrittenPost = {
  title: string;
  caption: string;
  hashtags: string[];
  tags: { mediaPosition: number; metaProductId: string; label: string; x: number; y: number }[];
  notFound: string[];
};

type Draft = {
  title: string;
  caption: string;
  hashtags: string[];
  products: { media_position: number; product_name: string; colour: string | null; x: number; y: number }[];
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "caption", "hashtags", "products"],
  properties: {
    title: { type: "string" },
    caption: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    products: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["media_position", "product_name", "colour", "x", "y"],
        properties: {
          media_position: { type: "integer" }, product_name: { type: "string" },
          colour: { anyOf: [{ type: "string" }, { type: "null" }] }, x: { type: "number" }, y: { type: "number" },
        },
      },
    },
  },
} as const;

export async function writePost(pool: Pool, tenantId: string, post: MarketingPost, brief: string): Promise<WrittenPost> {
  // The brand's own voice: its latest captions.
  const voice = await pool.query<{ caption: string }>(
    `SELECT caption FROM marketing_posts WHERE tenant_id = $1::uuid AND id <> $2::uuid AND length(caption) > 40
      ORDER BY (status IN ('approved','published')) DESC, updated_at DESC LIMIT 4`,
    [tenantId, post.id],
  );
  const content: ClaudeBlock[] = [];
  for (const m of post.media) {
    if (m.kind === "video") {
      // The video itself, not just its cover: the cover can show a look that is not in it.
      const frames = await videoFrames(m.url);
      if (frames.length) {
        content.push({ type: "text", text: `Picture ${m.position} is a VIDEO. ${frames.length} frames from start to end — write about these:` });
        for (const f of frames) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f } });
        if (m.coverUrl) {
          content.push({ type: "text", text: `The video's cover picture (only the thumbnail; if it shows a look that is not in the frames above, do not write about it):` });
          content.push({ type: "image", source: { type: "url", url: m.coverUrl } });
        }
      } else {
        content.push({ type: "text", text: `Picture ${m.position} (a video — its cover):` });
        if (m.coverUrl) content.push({ type: "image", source: { type: "url", url: m.coverUrl } });
      }
      continue;
    }
    content.push({ type: "text", text: `Picture ${m.position}:` });
    content.push({ type: "image", source: { type: "url", url: m.url } });
  }
  // What CARBON sells (published on Shopify), so products are named as sold, not described
  // ("cream puffer jacket", "teal" for TURQUOISE found nothing in the catalog).
  const catalog = await pool.query<{ line: string }>(
    `SELECT m.description || ' (' || COALESCE(NULLIF(m.subcategory_1, ''), NULLIF(m.category, ''), 'clothing') || ') — ' ||
            string_agg(DISTINCT cs.color_code, ', ') AS line
       FROM matrices m JOIN custom_skus cs ON cs.matrix_id = m.id AND cs.archived = FALSE
      WHERE m.shopify_product_id IS NOT NULL AND m.shopify_sync_status = 'published'
      GROUP BY m.id, m.description, m.subcategory_1, m.category
      ORDER BY m.description`,
  );
  content.push({
    type: "text",
    text: [
      catalog.rows.length ? `CARBON's catalog — "name (type) — colours". Name products ONLY from this list:\n${catalog.rows.map((r) => r.line).join("\n")}` : "",
      `Format: ${post.format}. Channels: ${post.targets.map((t) => t.provider).join(" + ") || "instagram + facebook"}.`,
      post.caption.trim() ? `The caption so far (improve it, keep what is good):\n${post.caption}` : "",
      voice.rows.length ? `CARBON's recent captions — write in this voice:\n${voice.rows.map((r) => `---\n${r.caption}`).join("\n")}` : "",
      brief.trim() ? `THE BRIEF FROM THE OWNER:\n${brief.trim()}` : "No brief — write from the pictures.",
    ].filter(Boolean).join("\n\n"),
  });
  const system = `You write one Instagram and Facebook post for CARBON, a fashion boutique in Orlando, Florida. Look closely at the pictures and write about what is really in them.

${COPY_RULES}

Fields:
- title: a short working name for the calendar (3–6 words).
- caption: the caption without hashtags. Open with the clothes or the moment, not "Introducing". Name the pieces by their colour and cut as they look in the picture. End with one plain call to action (the shop link is in the bio). Under 900 characters.
- hashtags: 3 to 5 (Instagram allows 5), WITHOUT the # sign, mixing CARBON's own (e.g. CARBON, TheArtOfArriving when it fits) with ones shoppers search.
- products: every CARBON piece you can see. product_name is copied exactly from CARBON's catalog list, and colour is exactly one of the colours listed for it (the catalog's word, e.g. TURQUOISE, not "teal"). Only pick a catalog name when its type and colour fit the piece you see; if no listed product fits, leave that piece out. Give which picture, and x, y from 0 to 1 on the piece. ${TAG_PLACEMENT} At most 5 per picture.

For a Reel (a video): write about what the frames show from start to end, the looks the viewer will actually see. The cover is only the thumbnail. For products, pick the 5 pieces that are clearest and on screen longest, and give the video's picture number.`;
  const identity = campaignIdentity(post.campaign);
  const d = await claudeStructured<Draft>({ system: identity ? `${system}\n\n${identity}` : system, content, schema: SCHEMA as unknown as Record<string, unknown>, effort: "high" });

  const tags: WrittenPost["tags"] = [];
  const notFound: string[] = [];
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0.5)) * 100) / 100;
  // A Reel is tagged on its video (Instagram takes up to 5 there, without positions).
  const reelVideo = post.format === "reel" ? post.media.find((m) => m.kind === "video")?.position : undefined;
  for (const p of d.products) {
    if (reelVideo != null) p.media_position = reelVideo;
    if (tags.filter((t) => t.mediaPosition === p.media_position).length >= 5) continue;
    if (!post.media.some((m) => m.position === p.media_position && (m.kind === "image" || m.position === reelVideo))) continue;
    const hit = pickCatalogProduct(await searchCatalogProducts(p.product_name).catch(() => []), p.product_name, p.colour);
    if (!hit) {
      notFound.push(`${p.product_name}${p.colour ? ` (${p.colour})` : ""}`);
      continue;
    }
    if (tags.some((t) => t.mediaPosition === p.media_position && t.metaProductId === hit.id)) continue;
    const colour = hit.color ? ` ${hit.color.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : "";
    tags.push({ mediaPosition: p.media_position, metaProductId: hit.id, label: `${hit.name}${colour}`, x: clamp(p.x), y: clamp(p.y) });
  }
  return {
    title: d.title.trim().slice(0, 200),
    caption: d.caption.trim().slice(0, 2200),
    hashtags: d.hashtags.map((h) => h.trim().replace(/^#+/, "")).filter(Boolean).slice(0, 5),
    tags,
    notFound,
  };
}
