/**
 * CarbonWMS Email — the store and the brand media library for the AI Designer
 * (owner, 2026-11-07: "install all … check Shopify content, you'll find all
 * media … About Us and Store Locator pages").
 *
 * STORE: the showroom facts exactly as shopcarbon.com shows them (About Us
 * "CARBON at a Glance" + /pages/retail-store-locator), and the two store
 * pictures from the About Us page (outside with the 6250 CARBON sign, inside).
 *
 * MEDIA: every picture in Shopify Files (newest first). Each one is looked at
 * once by the AI, which writes a short description, its kind, and whether an
 * email may use it as a photo (no words on it, not a notice or an icon). The
 * worker does this a few pictures per minute (emailWorkPending → tick), and
 * looks for new files once a day. The planner sees the usable list as M-refs
 * and picks pictures; the picture model gets them as references, and "Convert
 * to email" uses the real files.
 */
import sharp from "sharp";
import type { Pool } from "pg";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { openai, textModel } from "./config";

export const STORE = {
  name: "CARBON Showroom",
  address: "6250 Edgewater Drive, Suite 100, Orlando, FL 32810",
  hours: "Mon–Tue 12–7 PM · Wed closed · Thu–Sat 12–7 PM · Sun closed",
  phone: "(407) 773-1399",
  email: "support@shopcarbon.com",
  directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=6250+Edgewater+Drive%2C+Suite+100%2C+Orlando%2C+FL+32810",
  locatorUrl: "https://shopcarbon.com/pages/retail-store-locator",
  aboutUrl: "https://shopcarbon.com/pages/about-us",
};

/** Store facts for the planner / converter. */
export const STORE_TEXT = `THE STORE (exact, from shopcarbon.com About Us + Store Locator): ${STORE.name}, ${STORE.address}. Hours: ${STORE.hours}. Phone ${STORE.phone}. Email ${STORE.email}. "Get directions" opens Google Maps: ${STORE.directionsUrl}. Store page: ${STORE.locatorUrl}. Free U.S. & Canada shipping on orders over $125. Returns: exchange or store credit within 14 days.`;

export type MediaItem = { ref: string; id: string; url: string; width: number; height: number; kind: string; description: string };
export type TurnMedia = Omit<MediaItem, "ref">;

const SHOP_FILES = "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/";

/** Pinned: the About Us store pictures (always first, S-refs). */
export const STORE_MEDIA: MediaItem[] = [
  {
    ref: "S1",
    id: "store-outside",
    url: `${SHOP_FILES}ChatGPT_Image_Jun_12_2026_12_43_51_AM.png?v=1781252379`,
    width: 1448,
    height: 1086,
    kind: "store",
    description: "The CARBON store from outside: white building, dark band with the hexagon CARBON logo and 6250, glass front door, palms and parking, blue sky.",
  },
  {
    ref: "S2",
    id: "store-inside",
    url: `${SHOP_FILES}ChatGPT_Image_Jun_12_2026_12_30_10_AM.png?v=1781252368`,
    width: 1448,
    height: 1086,
    kind: "store",
    description: "Inside the CARBON store: bright white floor, rails of shirts and denim, folded jeans on white tables, wooden slat feature wall with the logo, mannequins, shoe wall.",
  },
];

/* -------------------------------------------------------------- the library */

type FileNode = { id: string; alt: string | null; createdAt: string; image?: { url: string; width: number; height: number } | null };

/** Product-photo file names the catalog already covers (WMS photo pipeline). */
const SKIP_NAME = /(_W_|_M_|BUTTON|how_it_works|icon|note-|set-note|swatch)/i;

/** Look for new pictures in Shopify Files (newest first, up to 1,500). */
async function listShopifyFiles(pool: Pool): Promise<number> {
  const ctx = await welcomeShopCtx();
  if (!ctx) throw new Error("Shopify is not connected");
  let after: string | null = null;
  let seen = 0;
  for (let page = 0; page < 15; page++) {
    const d: { files: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: FileNode[] } } = await welcomeGql(
      ctx,
      `query Media($after: String) { files(first: 100, after: $after, sortKey: CREATED_AT, reverse: true, query: "media_type:IMAGE") {
         pageInfo { hasNextPage endCursor }
         nodes { id alt createdAt ... on MediaImage { image { url width height } } } } }`,
      { after },
    );
    for (const n of d.files.nodes) {
      const img = n.image;
      if (!img?.url || img.width < 700 || img.height < 500) continue;
      const name = decodeURIComponent(new URL(img.url).pathname.split("/").pop() ?? "");
      if (SKIP_NAME.test(name)) continue;
      seen++;
      await pool.query(
        `INSERT INTO email_media (file_gid, url, width, height, alt, file_created) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (file_gid) DO UPDATE SET url = EXCLUDED.url, width = EXCLUDED.width, height = EXCLUDED.height, alt = EXCLUDED.alt, seen_at = now()`,
        [n.id, img.url, img.width, img.height, n.alt || null, n.createdAt],
      );
    }
    if (!d.files.pageInfo.hasNextPage) break;
    after = d.files.pageInfo.endCursor;
  }
  // Files deleted in Shopify leave the library.
  await pool.query(`DELETE FROM email_media WHERE seen_at < now() - interval '3 days'`);
  await pool.query(`UPDATE email_media_sync SET listed_at = now(), files_seen = $1 WHERE id = 1`, [seen]);
  return seen;
}

const DESCRIBE = `You sort pictures for CARBON, an Orlando fashion store (men's and women's streetwear, denim, going-out looks), so its email designer can reuse them.
Answer JSON: {"kind": "campaign|lifestyle|model|product|store|graphic|text|other", "usable": true|false, "description": "..."}
- kind: campaign = styled ad/banner photo with models; lifestyle = people in a scene; model = one model on a plain backdrop; product = garment only; store = a shop inside/outside; graphic = logo, icon, pattern, illustration; text = mostly words, a notice or a chart.
- usable: true only for a clean, good-looking PHOTO an email could show as is: no words, prices, buttons or notices written on it, not blurry, not a collage of screenshots, not an icon.
- description: one sentence (max 35 words): who/what is shown, clothing and colours, setting, light, and the shape (wide banner / square / tall).`;

/** Describe up to `max` pictures not looked at yet. */
async function describeSome(pool: Pool, max: number): Promise<number> {
  const todo = await pool.query<{ file_gid: string; url: string; alt: string | null; width: number; height: number }>(
    `SELECT file_gid, url, alt, width, height FROM email_media WHERE described_at IS NULL ORDER BY file_created DESC NULLS LAST LIMIT $1`,
    [max],
  );
  let done = 0;
  for (const f of todo.rows) {
    try {
      const u = new URL(f.url);
      u.searchParams.set("width", "640");
      const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`picture HTTP ${r.status}`);
      const jpg = await sharp(Buffer.from(await r.arrayBuffer())).rotate().flatten({ background: "#ffffff" }).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      const c = await openai().chat.completions.create({
        model: textModel(),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: DESCRIBE },
          {
            role: "user",
            content: [
              { type: "text", text: `Picture ${f.width}x${f.height}${f.alt ? `, its alt text: "${f.alt}"` : ""}.` },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpg.toString("base64")}`, detail: "low" } },
            ],
          },
        ],
      });
      const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as { kind?: string; usable?: boolean; description?: string };
      const kinds = ["campaign", "lifestyle", "model", "product", "store", "graphic", "text", "other"];
      await pool.query(
        `UPDATE email_media SET described_at = now(), kind = $2, usable = $3, description = $4, error = NULL WHERE file_gid = $1`,
        [f.file_gid, kinds.includes(String(j.kind)) ? j.kind : "other", j.usable === true, String(j.description ?? "").slice(0, 400)],
      );
      done++;
    } catch (e) {
      // Marked as looked at (not usable) so one broken file never blocks the rest.
      await pool.query(`UPDATE email_media SET described_at = now(), usable = false, error = $2 WHERE file_gid = $1`, [f.file_gid, (e instanceof Error ? e.message : String(e)).slice(0, 300)]);
    }
  }
  return done;
}

/** Worker step: list Shopify Files once a day, then describe a few pictures per tick. */
export async function runMediaSync(pool: Pool): Promise<{ listed: number | null; described: number }> {
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('carbon_email_media')) AS ok`);
    if (!got.rows[0]?.ok) return { listed: null, described: 0 };
    const s = await pool.query<{ stale: boolean }>(`SELECT (listed_at IS NULL OR listed_at < now() - interval '1 day') AS stale FROM email_media_sync WHERE id = 1`);
    const listed = s.rows[0]?.stale ? await listShopifyFiles(pool) : null;
    const described = await describeSome(pool, 12);
    return { listed, described };
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('carbon_email_media'))`).catch(() => {});
    lock.release();
  }
}

/** The usable library for the planner: store pictures first, then newest. */
export async function mediaLibrary(pool: Pool, limit = 160): Promise<MediaItem[]> {
  const r = await pool.query<{ file_gid: string; url: string; width: number; height: number; kind: string; description: string }>(
    `SELECT file_gid, url, width, height, kind, description FROM email_media
      WHERE usable AND description <> '' ORDER BY (kind = 'store') DESC, file_created DESC NULLS LAST LIMIT $1`,
    [limit],
  ).catch(() => ({ rows: [] as { file_gid: string; url: string; width: number; height: number; kind: string; description: string }[] }));
  return [...STORE_MEDIA, ...r.rows.map((m, i) => ({ ref: `M${i + 1}`, id: m.file_gid, url: m.url, width: m.width, height: m.height, kind: m.kind, description: m.description }))];
}

export function mediaLines(items: MediaItem[]): string {
  const shape = (m: MediaItem) => (m.width / m.height > 1.6 ? "wide banner" : m.width / m.height < 0.85 ? "tall" : "square-ish");
  return items.map((m) => `${m.ref} | ${m.kind} | ${shape(m)} ${m.width}x${m.height} | ${m.description}`).join("\n");
}

/** A library picture as a picture-model reference (1024 px JPEG). */
export async function mediaPhoto(m: TurnMedia): Promise<Buffer | null> {
  const u = new URL(m.url);
  u.searchParams.set("width", "1024");
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r?.ok) return null;
  return sharp(Buffer.from(await r.arrayBuffer())).rotate().flatten({ background: "#ffffff" }).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}

/** For the Settings card: how far the library is. */
export async function mediaStatus(pool: Pool): Promise<{ total: number; described: number; usable: number; listedAt: string | null }> {
  const r = await pool.query<{ total: string; described: string; usable: string; listed_at: Date | null }>(
    `SELECT count(*) AS total, count(described_at) AS described, count(*) FILTER (WHERE usable) AS usable,
            (SELECT listed_at FROM email_media_sync WHERE id = 1) AS listed_at FROM email_media`,
  );
  const x = r.rows[0];
  return { total: Number(x?.total ?? 0), described: Number(x?.described ?? 0), usable: Number(x?.usable ?? 0) + STORE_MEDIA.length, listedAt: x?.listed_at?.toISOString() ?? null };
}
