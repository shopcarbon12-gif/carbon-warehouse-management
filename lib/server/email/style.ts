/**
 * CarbonWMS Email — the brand's Instagram look for the AI Designer (owner,
 * 2026-11-08: "the AW2026 collection has its own graphic language … from our
 * Instagram @shopcarbon").
 *
 * Every Instagram post CarbonCast published is in CarbonWMS (marketing_posts +
 * marketing_post_media, the same pictures and captions that went to
 * @shopcarbon). The newest campaign's pictures and captions are looked at once
 * by the AI, which writes a style guide: palette, type, graphic motifs, photo
 * style, copy voice, do's and don'ts, and picks the most typical pictures.
 * The planner reads the guide; the banner pictures get those pictures as style
 * references. Rebuilt when a week old or when a newer campaign has more posts.
 */
import sharp from "sharp";
import type { Pool } from "pg";
import { downloadStorageObject } from "@/lib/storageProvider";
import { openai, textModel } from "./config";

export type StyleGuide = {
  campaign: string | null;
  name: string;
  summary: string;
  palette: string[];
  typography: string;
  motifs: string;
  photo_style: string;
  layout_ideas: string;
  copy_voice: string;
  do: string[];
  dont: string[];
};

type Row = { campaign: string | null; guide: StyleGuide; ref_paths: string[]; built_at: Date };

const BUILD = `You are the art director of CARBON, an Orlando fashion store (men's and women's streetwear, denim, going-out looks).
You get the pictures and captions of CARBON's current Instagram campaign. Describe its GRAPHIC LANGUAGE so an email designer and an image generator can continue it exactly.
Answer JSON:
{"name": "the campaign's name/theme",
 "summary": "2-3 sentences: the idea and the mood",
 "palette": ["#hex", ... 4-7 colours actually used],
 "typography": "how type is used: families (serif/sans, condensed, wide), weights, case, letter-spacing, sizes, placement on pictures",
 "motifs": "recurring graphic elements: frames, rules, labels, numbering, hexagon cells, grids, stamps, tickers, overlays, corner marks, how the logo appears",
 "photo_style": "locations, time of day, light, colour grade, camera distance and angles, poses, styling, how many people, mood",
 "layout_ideas": "5-8 concrete layout / composition ideas taken from the posts that would work as email sections",
 "copy_voice": "how captions talk: sentence length, words they like, what they never say, sample phrases",
 "do": ["..."], "dont": ["..."],
 "typical": [indexes (0-based) of the 3 pictures that show the look best]}`;

async function jpegFromStorage(path: string, w = 768): Promise<Buffer | null> {
  try {
    const o = await downloadStorageObject(path);
    return await sharp(Buffer.from(o.body)).rotate().flatten({ background: "#ffffff" }).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}

async function build(pool: Pool, tenantId: string): Promise<Row | null> {
  const camp = await pool.query<{ campaign: string | null }>(
    `SELECT campaign FROM marketing_posts WHERE tenant_id = $1::uuid AND status = 'published' AND scheduled_at > now() - interval '120 days'
      GROUP BY campaign ORDER BY (campaign IS NOT NULL) DESC, count(*) DESC, max(scheduled_at) DESC LIMIT 1`,
    [tenantId],
  );
  if (!camp.rows.length) return null;
  const campaign = camp.rows[0].campaign;
  // One or two pictures per post, newest posts first, feed posts before stories.
  const media = await pool.query<{ storage_path: string; caption: string | null; title: string | null; format: string }>(
    `SELECT m.storage_path, p.caption, p.title, p.format FROM marketing_posts p JOIN marketing_post_media m ON m.post_id = p.id
      WHERE p.tenant_id = $1::uuid AND p.status = 'published' AND p.campaign IS NOT DISTINCT FROM $2 AND m.kind = 'image' AND m.storage_path IS NOT NULL AND m.position < 2
      ORDER BY (p.format = 'story'), p.scheduled_at DESC LIMIT 14`,
    [tenantId, campaign],
  );
  const pics: { path: string; jpg: Buffer }[] = [];
  for (const m of media.rows) {
    const jpg = await jpegFromStorage(m.storage_path);
    if (jpg) pics.push({ path: m.storage_path, jpg });
  }
  if (!pics.length) return null;
  const captions = [...new Set(media.rows.map((m) => (m.caption ?? "").trim()).filter(Boolean))].slice(0, 10);
  const c = await openai().chat.completions.create({
    model: textModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: BUILD },
      {
        role: "user",
        content: [
          { type: "text", text: `Campaign: ${campaign ?? "(no name)"}.\n\nCaptions:\n${captions.map((c, i) => `${i + 1}. ${c.slice(0, 700)}`).join("\n\n")}\n\nPictures follow, in order (0-based).` },
          ...pics.map((p) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${p.jpg.toString("base64")}`, detail: "low" as const } })),
        ],
      },
    ],
  });
  const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as Partial<StyleGuide> & { typical?: unknown };
  const str = (v: unknown, n = 1200) => String(v ?? "").slice(0, n);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 200)).slice(0, 10) : []);
  const guide: StyleGuide = {
    campaign,
    name: str(j.name, 120) || (campaign ?? "CARBON"),
    summary: str(j.summary),
    palette: list(j.palette).filter((x) => /^#[0-9a-f]{3,8}$/i.test(x)),
    typography: str(j.typography),
    motifs: str(j.motifs),
    photo_style: str(j.photo_style),
    layout_ideas: str(j.layout_ideas, 2000),
    copy_voice: str(j.copy_voice),
    do: list(j.do),
    dont: list(j.dont),
  };
  const typical = (Array.isArray(j.typical) ? j.typical : []).map(Number).filter((i) => Number.isInteger(i) && pics[i]).slice(0, 3);
  const refPaths = (typical.length ? typical : [0, 1, 2].filter((i) => pics[i])).map((i) => pics[i].path);
  await pool.query(
    `INSERT INTO email_style_guides (tenant_id, campaign, guide, ref_paths, posts_used, built_at) VALUES ($1::uuid, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET campaign = EXCLUDED.campaign, guide = EXCLUDED.guide, ref_paths = EXCLUDED.ref_paths, posts_used = EXCLUDED.posts_used, built_at = now()`,
    [tenantId, campaign, JSON.stringify(guide), JSON.stringify(refPaths), media.rows.length],
  );
  return { campaign, guide, ref_paths: refPaths, built_at: new Date() };
}

/** The current guide (built or rebuilt when needed; null when there are no published posts). */
export async function styleGuide(pool: Pool, tenantId: string): Promise<Row | null> {
  const r = await pool.query<Row>(`SELECT campaign, guide, ref_paths, built_at FROM email_style_guides WHERE tenant_id = $1::uuid`, [tenantId]).catch(() => ({ rows: [] as Row[] }));
  const cur = r.rows[0];
  if (cur && cur.built_at.getTime() > Date.now() - 7 * 86400_000) return cur;
  try {
    return (await build(pool, tenantId)) ?? cur ?? null;
  } catch (e) {
    console.warn("[email-style] guide could not be built:", e instanceof Error ? e.message : e);
    return cur ?? null;
  }
}

export function styleText(g: StyleGuide | null | undefined): string {
  if (!g) return "No Instagram campaign is published yet: use the clean CARBON black-and-white look.";
  return [
    `CARBON'S CURRENT INSTAGRAM CAMPAIGN (@shopcarbon): "${g.name}". ${g.summary}`,
    g.palette.length ? `Palette: ${g.palette.join(", ")}.` : "",
    `Typography: ${g.typography}`,
    `Graphic motifs: ${g.motifs}`,
    `Photo style: ${g.photo_style}`,
    `Layout ideas from the posts: ${g.layout_ideas}`,
    `Copy voice: ${g.copy_voice}`,
    g.do.length ? `Do: ${g.do.join("; ")}.` : "",
    g.dont.length ? `Don't: ${g.dont.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The typical campaign pictures, as picture-model style references. */
export async function styleRefs(row: Row | null, max = 2): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const p of (row?.ref_paths ?? []).slice(0, max)) {
    const b = await jpegFromStorage(p, 1024);
    if (b) out.push(b);
  }
  return out;
}
