/**
 * Social (ex-CarbonCast, ex-CarbonMarketing) — "Ask for changes" carried out by the AI (owner,
 * 2026-10-25: "the AI should follow what the changes are and execute them";
 * pictures automatically).
 *
 *   1. Ask for changes with a note queues the post (ai_status 'queued').
 *   2. Claude reads the note, the post and its pictures and returns a plan:
 *      caption, hashtags, time, channels, product tags to add / move / remove,
 *      and picture edits. Only what the note asks for changes.
 *   3. Text, time, channels and tags are written at once. Product tags are
 *      looked up in the Meta catalog by name and colour.
 *   4. A picture edit goes to the OpenAI batch (images/edits, half price) —
 *      ai_status 'picture' until it is back; the new picture replaces the old
 *      one on R2 (the old path is kept in marketing_post_changes).
 *   5. The post returns to 'draft' (waiting for approval) with ai_summary.
 *      The AI never approves a post.
 *
 * Runs in the web app (it holds the OpenAI, Anthropic, Meta and R2 keys): the
 * PATCH that asks for changes starts it, and the worker calls
 * /api/marketing/ai/tick every minute while anything is queued or a picture
 * is out.
 */
import type { Pool } from "pg";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { claudeConfigured, claudeStructured, type ClaudeBlock } from "@/lib/server/claude";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";
import { listPosts, PUBLISHABLE, type MarketingPost } from "./store";
import { searchCatalogProducts, type CatalogProduct } from "./meta";

const ET = "America/New_York";
const MAX_TAGS_PER_PICTURE = 5;
const STALE_WORKING_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
/** The owner's example of the carousel style (a garment hanging from a wire, 2026-10-25). */
const STYLE_EXAMPLE = "marketing/style/hanging-wire.jpg";
const SIZES: Record<string, string> = { "4:5": "1600x2000", "9:16": "1440x2560", "16:9": "2560x1440", "1:1": "2048x2048" };

type Plan = {
  caption: string | null;
  hashtags: string[] | null;
  scheduled_local: string | null;
  targets: string[] | null;
  remove_tags: { media_position: number; label: string }[];
  move_tags: { media_position: number; label: string; x: number; y: number }[];
  add_tags: { media_position: number; product_name: string; colour: string | null; x: number; y: number }[];
  picture_edits: { media_position: number; instruction: string; reference_positions: number[]; style_example: boolean }[];
  summary: string;
  cannot: string[];
};

type PictureState = {
  batchId: string;
  inputFileId: string;
  refFileIds: string[];
  edits: { position: number; instruction: string; customId: string }[];
  submittedAt: string;
  summary: string;
};

const nullable = (t: Record<string, unknown>) => ({ anyOf: [t, { type: "null" }] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["caption", "hashtags", "scheduled_local", "targets", "remove_tags", "move_tags", "add_tags", "picture_edits", "summary", "cannot"],
  properties: {
    caption: nullable({ type: "string" }),
    hashtags: nullable({ type: "array", items: { type: "string" } }),
    scheduled_local: nullable({ type: "string" }),
    targets: nullable({ type: "array", items: { type: "string", enum: ["instagram", "facebook", "bluesky", "tiktok"] } }),
    remove_tags: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["media_position", "label"], properties: { media_position: { type: "integer" }, label: { type: "string" } } },
    },
    move_tags: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["media_position", "label", "x", "y"],
        properties: { media_position: { type: "integer" }, label: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
      },
    },
    add_tags: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["media_position", "product_name", "colour", "x", "y"],
        properties: { media_position: { type: "integer" }, product_name: { type: "string" }, colour: nullable({ type: "string" }), x: { type: "number" }, y: { type: "number" } },
      },
    },
    picture_edits: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["media_position", "instruction", "reference_positions", "style_example"],
        properties: {
          media_position: { type: "integer" }, instruction: { type: "string" },
          reference_positions: { type: "array", items: { type: "integer" } }, style_example: { type: "boolean" },
        },
      },
    },
    summary: { type: "string" },
    cannot: { type: "array", items: { type: "string" } },
  },
} as const;

/** CARBON's copy rules for every Social caption (owner). */
export const COPY_RULES = `Copy rules (the owner's, always):
- The brand is written CARBON, in capitals. Never "Carbon Jeans".
- Never name another brand, shop or designer, and never say where anything is made or comes from.
- Never mention labels, patches or tags on the clothes.
- Never name a real venue, hotel or business, even if one appears in the picture.
- Plain, confident English. No exclamation marks unless the note asks for them.
- Instagram limits: caption up to 2,200 characters; up to 30 hashtags; up to ${MAX_TAGS_PER_PICTURE} product tags per picture.`;

const SYSTEM = `You edit one scheduled social post for CARBON, a fashion boutique in Orlando, Florida. The owner looked at the post and wrote a note asking for changes. Carry out exactly what the note asks — nothing more. Every field the note does not ask about stays unchanged (return null for it, or an empty list).

${COPY_RULES}
Fields:
- caption: the full new caption (without hashtags), or null if unchanged.
- hashtags: the full new list WITHOUT the # sign, or null if unchanged.
- scheduled_local: new day and time in Eastern time as "YYYY-MM-DDTHH:mm", or null. Never in the past.
- targets: the new channels, or null.
- Product tags: pictures are numbered from 0 (media_position). x and y are from 0 to 1 (left→right, top→bottom), on the product itself in that picture. add_tags names the product as it is sold (e.g. "Axel Coat") and its colour if the note or picture shows it; only products that are really visible in that picture. remove_tags / move_tags use the tag's label exactly as listed.
- picture_edits: when the note asks to change what a picture shows, write one precise instruction for a photo-editing model for that picture (what to change, where, and how it should look). The model keeps everything else as it is unless the instruction says otherwise. reference_positions: other pictures of this post the model should also see (e.g. picture 0 for its setting and light) — empty when none. Videos cannot be edited.

OWNER'S CAROUSEL RULE (2026-10-25, final): only for a carousel whose first picture is the campaign shot and whose next pictures each show ONE piece of that outfit (a catalog photo: product on white, a flat lay, a store photo, a person wearing it). Each such garment floats on its own in mid-air in the location and light of the carousel's first picture, with NOTHING holding it (no wire, string, hanger, mannequin or person), caught in motion as if just tossed or lifted by a breeze: sleeves or legs swing and bend loosely, the hem flares, real folds and drape — relaxed and alive, never a stiff ghost-mannequin shape. Shoes and bags stand on the ground of that place. The piece alone: no model and no SEPARATE styling item (other clothes, jewellery, bags) — but keep everything that belongs to the piece, including attached hardware (e.g. the silver chain on the Colin Evening Pants). Keep the piece exact — cut, colour, wash and distressing, print, stitching, hardware and every letter. If two such slides would show the same thing (e.g. a set photographed together), keep one. For each such slide give a picture_edit with reference_positions [0]. style_example is always false.
- summary: one or two short sentences for the owner saying what you changed. In summary and cannot, count pictures as the owner sees them: the first picture is picture 1.
- cannot: anything in the note you could not do, each with the reason in a few words.`;

/* ---------------------------------------------------------------- time */

/** Eastern wall clock "YYYY-MM-DDTHH:mm" → ISO instant (EDT or EST). */
export function etLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${local}:00${off}`);
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === local) return d.toISOString();
  }
  return null;
}

function etLabel(iso: string | null): string {
  if (!iso) return "no time set";
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/* ---------------------------------------------------------------- tick */

/**
 * One pass: send queued requests to the AI, check pictures that are out.
 * Safe to call often — one pass at a time (advisory lock).
 */
export async function runMarketingAi(pool: Pool, log: (m: string) => void = (m) => console.log(`[social-ai] ${m}`)) {
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('marketing_ai_tick')) AS ok`);
    if (!got.rows[0]?.ok) return { skipped: "busy" };
    try {
      // A pass that died half-way (deploy, crash) is tried again, a few times.
      await pool.query(
        `UPDATE marketing_posts SET ai_status = CASE WHEN ai_attempts >= $2 THEN 'failed' ELSE 'queued' END,
                ai_error = CASE WHEN ai_attempts >= $2 THEN 'The AI stopped part-way several times.' ELSE ai_error END
          WHERE ai_status = 'working' AND updated_at < now() - $1::interval`,
        [`${STALE_WORKING_MS / 1000} seconds`, MAX_ATTEMPTS],
      );
      const claimed = await pool.query<{ id: string; tenant_id: string }>(
        `UPDATE marketing_posts p SET ai_status = 'working', ai_attempts = ai_attempts + 1, ai_error = NULL, updated_at = now()
          WHERE p.id IN (SELECT id FROM marketing_posts WHERE ai_status = 'queued' ORDER BY ai_requested_at LIMIT 5 FOR UPDATE SKIP LOCKED)
          RETURNING p.id, p.tenant_id`,
      );
      let done = 0, failed = 0, pictures = 0;
      for (const c of claimed.rows) {
        try {
          const r = await processChange(pool, c.tenant_id, c.id, log);
          if (r === "picture") pictures++;
          else done++;
        } catch (e) {
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          log(`post ${c.id}: ${msg}`);
          await pool.query(
            `UPDATE marketing_posts SET ai_status = CASE WHEN ai_attempts >= $3 THEN 'failed' ELSE 'queued' END, ai_error = $2, updated_at = now() WHERE id = $1::uuid`,
            [c.id, msg.slice(0, 1000), MAX_ATTEMPTS],
          );
        }
      }
      const back = await pollPictures(pool, log);
      return { done, failed, pictures, picturesBack: back };
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('marketing_ai_tick'))`).catch(() => {});
    }
  } finally {
    lock.release();
  }
}

/** Anything for the AI to do (the worker asks before calling the tick). */
export async function marketingAiPending(pool: Pool): Promise<{ tenant_id: string; requested_by: string | null }[]> {
  const r = await pool.query<{ tenant_id: string; requested_by: string | null }>(
    `SELECT DISTINCT ON (tenant_id) tenant_id::text, ai_requested_by AS requested_by FROM marketing_posts
      WHERE ai_status IN ('queued', 'picture') OR (ai_status = 'working' AND updated_at < now() - interval '15 minutes')
      ORDER BY tenant_id, ai_requested_at DESC`,
  );
  return r.rows;
}

/* ---------------------------------------------------------------- one post */

async function processChange(pool: Pool, tenantId: string, id: string, log: (m: string) => void): Promise<"done" | "picture"> {
  const [post] = await listPosts(pool, tenantId, { ids: [id] });
  if (!post) throw new Error("Post not found");
  if (["publishing", "published", "partly_published"].includes(post.status)) {
    await finish(pool, id, "This post has already gone out, so nothing was changed.", null, "changes_requested");
    return "done";
  }
  const note = (post.note ?? "").trim();
  if (!note) {
    await finish(pool, id, null, null, post.status);
    return "done";
  }
  if (!claudeConfigured()) throw new Error("ANTHROPIC_API_KEY is not set on the server");

  const media = await pool.query<{ position: number; kind: string; url: string; storage_path: string | null; cover_url: string | null }>(
    `SELECT position, kind, url, storage_path, cover_url FROM marketing_post_media WHERE post_id = $1::uuid ORDER BY position`,
    [id],
  );
  const plan = await planChange(post, media.rows, note);
  log(`post ${id}: plan ${JSON.stringify(plan).slice(0, 400)}`);

  const cannot = [...plan.cannot];
  const before = { post, media: media.rows };

  // Product tags from the Meta catalog.
  const tagRows = post.tags.map((t) => ({ ...t }));
  for (const r of plan.remove_tags) {
    const i = tagRows.findIndex((t) => t.mediaPosition === r.media_position && t.label.toLowerCase() === r.label.toLowerCase());
    if (i >= 0) tagRows.splice(i, 1);
    else cannot.push(`No tag "${r.label}" on picture ${r.media_position + 1}.`);
  }
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0.5)) * 100) / 100;
  for (const mv of plan.move_tags) {
    const t = tagRows.find((x) => x.mediaPosition === mv.media_position && x.label.toLowerCase() === mv.label.toLowerCase());
    if (t) { t.x = clamp(mv.x); t.y = clamp(mv.y); }
  }
  for (const a of plan.add_tags) {
    if (!media.rows.some((m) => m.position === a.media_position && m.kind === "image")) {
      cannot.push(`${a.product_name}: picture ${a.media_position + 1} is not a photo, so it cannot carry a tag.`);
      continue;
    }
    if (tagRows.filter((t) => t.mediaPosition === a.media_position).length >= MAX_TAGS_PER_PICTURE) {
      cannot.push(`${a.product_name}: picture ${a.media_position + 1} already has ${MAX_TAGS_PER_PICTURE} tags (Instagram's limit).`);
      continue;
    }
    const hit = pickCatalogProduct(await searchCatalogProducts(a.product_name).catch(() => []), a.product_name, a.colour);
    if (!hit) {
      cannot.push(`${a.product_name}${a.colour ? ` (${a.colour})` : ""} is not in the shop catalog in stock, so it was not tagged.`);
      continue;
    }
    if (tagRows.some((t) => t.mediaPosition === a.media_position && t.metaProductId === hit.id)) continue;
    const label = `${hit.name}${hit.color ? ` ${titleCase(hit.color)}` : ""}`;
    tagRows.push({ mediaPosition: a.media_position, metaProductId: hit.id, handle: null, label, x: clamp(a.x), y: clamp(a.y) });
  }

  let scheduledAt: string | null = null;
  if (plan.scheduled_local) {
    const iso = etLocalToIso(plan.scheduled_local);
    if (!iso) cannot.push(`The time "${plan.scheduled_local}" could not be read.`);
    else if (new Date(iso).getTime() < Date.now()) cannot.push("The new time is in the past, so the time was kept.");
    else scheduledAt = iso;
  }
  const targets = plan.targets?.filter((t) => (PUBLISHABLE as readonly string[]).includes(t)) ?? null;
  const hashtags = plan.hashtags?.map((h) => h.trim().replace(/^#+/, "")).filter(Boolean).slice(0, 30) ?? null;
  const caption = plan.caption != null ? plan.caption.slice(0, 2200) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (caption != null) set("caption", caption);
    if (hashtags) set("hashtags", hashtags);
    if (scheduledAt) set("scheduled_at", scheduledAt);
    if (sets.length) await client.query(`UPDATE marketing_posts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, vals);
    if (targets?.length) {
      await client.query(`DELETE FROM marketing_post_targets WHERE post_id = $1::uuid AND provider <> ALL($2::text[])`, [id, targets]);
      for (const t of targets) await client.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`, [id, t]);
    }
    const tagsChanged = JSON.stringify(tagRows) !== JSON.stringify(post.tags);
    if (tagsChanged) {
      await client.query(`DELETE FROM marketing_post_tags WHERE post_id = $1::uuid`, [id]);
      for (const t of tagRows) {
        await client.query(
          `INSERT INTO marketing_post_tags (post_id, media_position, meta_product_id, shopify_handle, label, x, y) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
          [id, t.mediaPosition, t.metaProductId, t.handle, t.label, t.x, t.y],
        );
      }
    }
    await client.query(`INSERT INTO marketing_post_changes (post_id, note, summary, plan, before) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)`, [
      id, note, plan.summary, JSON.stringify(plan), JSON.stringify(before),
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const edits = plan.picture_edits.filter((e) => media.rows.some((m) => m.position === e.media_position && m.kind === "image" && m.storage_path));
  for (const e of plan.picture_edits) if (!edits.includes(e)) cannot.push(`Picture ${e.media_position + 1} cannot be edited (it is a video or has no stored file).`);
  const summary = summaryText(plan.summary, cannot);
  if (!edits.length) {
    await finish(pool, id, summary, null, "draft");
    return "done";
  }
  const state = await submitPictures(id, media.rows, edits, summary);
  await pool.query(`UPDATE marketing_posts SET ai_status = 'picture', ai_picture = $2::jsonb, ai_summary = $3, updated_at = now() WHERE id = $1::uuid`, [
    id, JSON.stringify(state), `${summary} The new picture is being made (usually within an hour, at most a day).`,
  ]);
  log(`post ${id}: ${edits.length} picture edit(s) sent, batch ${state.batchId}`);
  return "picture";
}

/** What the AI would change for this note (nothing is written). */
export async function planChange(
  post: MarketingPost,
  mediaRows: { position: number; kind: string; url: string; cover_url: string | null }[],
  note: string,
): Promise<Plan> {
  const media = { rows: mediaRows };
  const content: ClaudeBlock[] = [];
  for (const m of media.rows) {
    const still = m.kind === "video" ? m.cover_url : m.url;
    content.push({ type: "text", text: `Picture ${m.position}${m.kind === "video" ? " (a video — its cover below)" : ""}:` });
    if (still) content.push({ type: "image", source: { type: "url", url: still } });
    else content.push({ type: "text", text: "(a video with no still picture)" });
  }
  const today = new Date().toLocaleString("en-US", { timeZone: ET, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  content.push({
    type: "text",
    text: [
      `Now (Eastern): ${today}.`,
      `Post: "${post.title}" — ${post.format}${post.format === "carousel" ? ` of ${media.rows.length} pictures` : ""}.`,
      `Goes out: ${etLabel(post.scheduledAt)} (Eastern), to ${post.targets.map((t) => t.provider).join(" + ") || "no channel"}.`,
      `Caption:\n${post.caption}`,
      `Hashtags: ${post.hashtags.join(" ") || "(none)"}`,
      `Product tags: ${post.tags.length ? post.tags.map((t) => `picture ${t.mediaPosition}: "${t.label}" at x ${t.x}, y ${t.y}`).join("; ") : "(none)"}`,
      "",
      `THE OWNER'S NOTE:\n${note}`,
    ].join("\n"),
  });

  return await claudeStructured<Plan>({ system: SYSTEM, content, schema: SCHEMA as unknown as Record<string, unknown>, effort: "high" });
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The catalog item for a product name + colour: exact name first, in stock and published. */
export function pickCatalogProduct(list: CatalogProduct[], name: string, colour: string | null): CatalogProduct | null {
  const n = name.trim().toLowerCase();
  const c = colour?.trim().toLowerCase() ?? "";
  const live = list.filter((p) => p.availability === "in stock" && p.visibility !== "hidden");
  const exact = live.filter((p) => p.name.trim().toLowerCase() === n);
  const pool = exact.length ? exact : live.filter((p) => p.name.toLowerCase().includes(n));
  if (!pool.length) return null;
  if (c) {
    const col = (p: CatalogProduct) => (p.color ?? "").toLowerCase();
    const words = (x: string) => x.split(/[^a-z]+/).filter((w) => w.length > 2 && !["mid", "deep", "dark", "light", "washed", "wash"].includes(w));
    const byColour =
      pool.find((p) => col(p) === c) ??
      pool.find((p) => col(p) && (col(p).includes(c) || c.includes(col(p)))) ??
      // "mid-blue" ↔ "BLUE WASHED", "deep blue" ↔ "BLUE": the main colour word.
      pool.find((p) => words(col(p)).some((w) => words(c).includes(w)));
    if (byColour) return byColour;
    // Only one colour exists for it: that is the one in the picture.
    const colours = new Set(pool.map(col).filter(Boolean));
    if (colours.size === 1) return pool[0];
    // A colour the catalog does not have for it: not that product.
    if (colours.size) return null;
  }
  return pool[0];
}

function summaryText(summary: string, cannot: string[]): string {
  const s = summary.trim() || "Changes made.";
  return cannot.length ? `${s} Could not: ${cannot.join(" ")}` : s;
}

async function finish(pool: Pool, id: string, summary: string | null, error: string | null, status: string) {
  await pool.query(
    `UPDATE marketing_posts SET ai_status = 'done', ai_summary = $2, ai_error = $3, ai_picture = NULL, status = $4,
            approved_by = NULL, approved_at = NULL, updated_at = now()
      WHERE id = $1::uuid`,
    [id, summary, error, status],
  );
}

/* ---------------------------------------------------------------- pictures */

function openai(): OpenAI {
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set on the server");
  return new OpenAI({ apiKey });
}

function sizeFor(w: number, h: number): string {
  const r = w / h;
  const best = Object.entries({ "4:5": 0.8, "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 }).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
  return SIZES[best];
}

export function editPrompt(instruction: string, references = 0, styleExample = false): string {
  if (references > 0 || styleExample)
    return [
      "Make a CARBON fashion campaign photograph.",
      `The FIRST image is the picture to change.${references > 0 ? ` The next image${references > 1 ? "s are references" : " is a reference"} from the same post (setting, light, colour grade).` : ""}`,
      ...(styleExample
        ? ["The LAST image only shows the STYLE wanted: a garment hanging in mid-air from a thin wire, shaped as if worn with nobody in it. Copy only that way of showing it — never its garment, colour, white tee or setting unless the instruction asks for them."]
        : []),
      `Do this: ${instruction.trim()}`,
      "Every garment and accessory from the first image stays exactly as it is: cut, colour, print, fabric, fit, stitching and hardware. Invent nothing on it.",
      "A real photograph — no added text, logos, watermarks, signs or brand names.",
    ].join("\n");
  return [
    "Edit this CARBON fashion campaign photograph.",
    `Change ONLY this: ${instruction.trim()}`,
    "Keep everything else exactly as it is: every person, face, hair, body and pose; every garment and accessory (cut, colour, print, fit, hardware); the setting, light, camera angle and framing.",
    "A real photograph — no added text, logos, watermarks, signs or brand names.",
  ].join("\n");
}

async function submitPictures(
  postId: string,
  media: { position: number; storage_path: string | null }[],
  edits: { media_position: number; instruction: string; reference_positions?: number[]; style_example?: boolean }[],
  summary: string,
): Promise<PictureState> {
  const ai = openai();
  const model = (process.env.OPENAI_IMAGE_MODEL || "").trim() || "gpt-image-2.5-sunburst";
  const refFileIds: string[] = [];
  const lines: string[] = [];
  const list: PictureState["edits"] = [];
  const fileFor = new Map<number, string>();
  let styleFile: string | null = null;
  async function upload(position: number): Promise<{ id: string; w: number; h: number } | null> {
    const m = media.find((x) => x.position === position);
    if (!m?.storage_path) return null;
    const obj = await downloadStorageObject(m.storage_path);
    const buf = Buffer.from(obj.body);
    const meta = await sharp(buf).metadata();
    let id = fileFor.get(position);
    if (!id) {
      const jpg = await sharp(buf).rotate().jpeg({ quality: 92 }).toBuffer();
      const f = await ai.files.create({ file: await toFile(jpg, `post-${postId}-${position}.jpg`, { type: "image/jpeg" }), purpose: "vision" });
      id = f.id;
      fileFor.set(position, id);
      refFileIds.push(id);
    }
    return { id, w: meta.width ?? 1600, h: meta.height ?? 2000 };
  }
  for (const e of edits) {
    const main = await upload(e.media_position);
    if (!main) continue;
    const refs: string[] = [];
    for (const r of (e.reference_positions ?? []).filter((r) => r !== e.media_position).slice(0, 4)) {
      const f = await upload(r);
      if (f) refs.push(f.id);
    }
    if ((e as { style_example?: boolean }).style_example) {
      if (!styleFile) {
        const obj = await downloadStorageObject(STYLE_EXAMPLE);
        const f = await ai.files.create({ file: await toFile(Buffer.from(obj.body), "style-hanging.jpg", { type: "image/jpeg" }), purpose: "vision" });
        styleFile = f.id;
        refFileIds.push(f.id);
      }
      refs.push(styleFile);
    }
    const styled = Boolean((e as { style_example?: boolean }).style_example);
    const customId = `${postId}:${e.media_position}`;
    list.push({ position: e.media_position, instruction: e.instruction, customId });
    // The post's own shape (a carousel's slides all match its first picture).
    const shapeFrom = refs.length ? (await upload((e.reference_positions ?? [])[0])) ?? main : main;
    lines.push(JSON.stringify({
      custom_id: customId,
      method: "POST",
      url: "/v1/images/edits",
      body: {
        model, prompt: editPrompt(e.instruction, refs.length - (styled ? 1 : 0), styled), images: [main.id, ...refs].map((file_id) => ({ file_id })),
        size: sizeFor(shapeFrom.w, shapeFrom.h), quality: "high", moderation: "low", n: 1,
      },
    }));
  }
  const input = await ai.files.create({ file: await toFile(Buffer.from(lines.join("\n") + "\n"), `social-${postId}.jsonl`, { type: "application/jsonl" }), purpose: "batch" });
  const batch = await ai.batches.create({ input_file_id: input.id, endpoint: "/v1/images/edits", completion_window: "24h", metadata: { social_post_id: postId } });
  return { batchId: batch.id, inputFileId: input.id, refFileIds, edits: list, submittedAt: new Date().toISOString(), summary };
}

async function pollPictures(pool: Pool, log: (m: string) => void): Promise<number> {
  const out = await pool.query<{ id: string; ai_picture: PictureState }>(`SELECT id::text, ai_picture FROM marketing_posts WHERE ai_status = 'picture' AND ai_picture IS NOT NULL`);
  if (!out.rows.length) return 0;
  const ai = openai();
  let back = 0;
  for (const row of out.rows) {
    const st = row.ai_picture;
    try {
      const b = await ai.batches.retrieve(st.batchId);
      if (["validating", "in_progress", "finalizing"].includes(b.status)) continue;
      if (b.status !== "completed" || !b.output_file_id) {
        let why = `the picture service stopped (${b.status})`;
        if (b.error_file_id) why += `: ${(await (await ai.files.content(b.error_file_id)).text()).slice(0, 300)}`;
        await finish(pool, row.id, `${st.summary} The new picture could not be made — ${why}.`, why, "changes_requested");
        await cleanup(ai, st, b.output_file_id, b.error_file_id);
        continue;
      }
      const text = await (await ai.files.content(b.output_file_id)).text();
      const made: number[] = [];
      const failed: string[] = [];
      for (const line of text.split("\n").filter(Boolean)) {
        const r = JSON.parse(line) as { custom_id: string; response?: { status_code: number; body?: { data?: { b64_json?: string }[]; error?: { message?: string } } }; error?: { message?: string } };
        const e = st.edits.find((x) => x.customId === r.custom_id);
        if (!e) continue;
        const b64 = r.response?.body?.data?.[0]?.b64_json;
        if (!b64) {
          failed.push(`picture ${e.position + 1}: ${r.response?.body?.error?.message ?? r.error?.message ?? "no picture came back"}`);
          continue;
        }
        const jpg = await sharp(Buffer.from(b64, "base64")).jpeg({ quality: 93, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
        const path = `marketing/ai/${row.id}/${e.position}-${Date.now()}.jpg`;
        await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
        // Same media row (its public link stays); ?v= so Instagram, Facebook and the app fetch the new picture.
        await pool.query(
          `UPDATE marketing_post_media SET storage_path = $3, url = split_part(url, '?', 1) || '?v=' || $4 WHERE post_id = $1::uuid AND position = $2`,
          [row.id, e.position, path, String(Date.now())],
        );
        made.push(e.position);
      }
      const note = made.length ? ` New picture${made.length > 1 ? "s" : ""}: ${made.map((p) => p + 1).join(", ")} — check the product tags still sit on the right spot.` : "";
      const bad = failed.length ? ` Not made: ${failed.join("; ")}.` : "";
      await finish(pool, row.id, `${st.summary}${note}${bad}`, failed.length ? failed.join("; ") : null, made.length ? "draft" : "changes_requested");
      await cleanup(ai, st, b.output_file_id, b.error_file_id);
      back++;
      log(`post ${row.id}: ${made.length} picture(s) back, ${failed.length} failed`);
    } catch (e) {
      log(`post ${row.id}: picture check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return back;
}

async function cleanup(ai: OpenAI, st: PictureState, ...more: (string | null | undefined)[]) {
  for (const f of [st.inputFileId, ...st.refFileIds, ...more]) if (f) await ai.files.delete(f).catch(() => {});
}

export type { Plan as MarketingAiPlan, MarketingPost };
