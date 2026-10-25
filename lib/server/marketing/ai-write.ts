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
import { COPY_RULES, pickCatalogProduct } from "./ai-changes";
import { searchCatalogProducts } from "./meta";
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
    const still = m.kind === "video" ? m.coverUrl : m.url;
    content.push({ type: "text", text: `Picture ${m.position}${m.kind === "video" ? " (a video — its cover)" : ""}:` });
    if (still) content.push({ type: "image", source: { type: "url", url: still } });
  }
  content.push({
    type: "text",
    text: [
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
- hashtags: 5 to 12, WITHOUT the # sign, mixing CARBON's own (e.g. CARBON, TheArtOfArriving when it fits) with ones shoppers search.
- products: every CARBON piece you can see, by the name it is sold under if the brief or caption gives it, else a plain description (e.g. "black puffer coat"); its colour; which picture; and x, y from 0 to 1 on the piece. At most 5 per picture.`;
  const d = await claudeStructured<Draft>({ system, content, schema: SCHEMA as unknown as Record<string, unknown>, effort: "high" });

  const tags: WrittenPost["tags"] = [];
  const notFound: string[] = [];
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0.5)) * 100) / 100;
  for (const p of d.products) {
    if (tags.filter((t) => t.mediaPosition === p.media_position).length >= 5) continue;
    if (!post.media.some((m) => m.position === p.media_position && m.kind === "image")) continue;
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
    hashtags: d.hashtags.map((h) => h.trim().replace(/^#+/, "")).filter(Boolean).slice(0, 30),
    tags,
    notFound,
  };
}
