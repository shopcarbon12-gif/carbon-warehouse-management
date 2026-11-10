/**
 * CarbonWMS Creative — Post (spec §10, Publisher). A finished creative becomes a CarbonCast post
 * (Social → Calendar): media copied in, caption + hashtags, a best-time slot, channels Instagram +
 * Facebook. It still needs the owner's approval there, like every post — nothing is published from
 * here directly. CarbonCast publishes with product tags (Metricool can't) and pulls the results
 * back every 3 h; creative_posts links them to the recipe / models / preset for the learning loop.
 */
import type { Pool } from "pg";
import { uploadBytesToStorage } from "@/lib/storageProvider";
import { publicMediaUrl } from "@/lib/server/marketing/store";
import { PlainError } from "./config";
import { getFile } from "./storage";

export interface Publisher {
  schedule(post: { projectId: string; caption: string; hashtags: string[]; at: string | null; format: "image" | "carousel" | "reel" | "story" }): Promise<{ postId: string }>;
}

/** Next best-time slot (CarbonCast's Best time table) at least 2 h from now, Eastern. */
export async function nextBestTime(pool: Pool, tenantId: string): Promise<string | null> {
  const r = await pool.query<{ weekday: number; hour: number; score: string }>(`SELECT weekday, hour, score FROM marketing_best_times WHERE tenant_id = $1::uuid AND provider = 'instagram' ORDER BY score DESC LIMIT 30`, [tenantId]).catch(() => ({ rows: [] as { weekday: number; hour: number; score: string }[] }));
  if (!r.rows.length) return null;
  const now = Date.now() + 2 * 3600_000;
  let best: number | null = null;
  for (const s of r.rows.slice(0, 12)) {
    for (let d = 0; d < 8; d++) {
      const t = new Date(now + d * 86_400_000);
      const et = new Date(t.toLocaleString("en-US", { timeZone: "America/New_York" }));
      if (et.getDay() !== s.weekday) continue;
      et.setHours(s.hour, 0, 0, 0);
      const offset = t.getTime() - new Date(t.toLocaleString("en-US", { timeZone: "America/New_York" })).getTime();
      const utc = et.getTime() + offset;
      if (utc >= now && (best == null || utc < best)) best = utc;
    }
  }
  return best ? new Date(best).toISOString() : null;
}

export async function createCarbonCastPost(
  pool: Pool,
  tenantId: string,
  v: { projectId: string; files: { path: string; kind: "image" | "video"; cover?: string | null }[]; caption: string; hashtags: string[]; format: "image" | "carousel" | "reel" | "story"; at: string | null; by: string | null; title: string; meta: { recipe: string | null; models: string[]; preset: string | null; music: string | null; hook: string | null } },
): Promise<string> {
  if (!v.files.length) throw new PlainError("Nothing to post yet — finish the render first.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query<{ id: string }>(
      `INSERT INTO marketing_posts (tenant_id, campaign, source_ref, title, format, caption, hashtags, scheduled_at, status, created_by, note)
       VALUES ($1::uuid, 'Creative', $2, $3, $4, $5, $6, $7, 'draft', $8, $9) RETURNING id`,
      [tenantId, `creative:${v.projectId}:${Date.now()}`, v.title.slice(0, 200), v.format, v.caption.slice(0, 2200), v.hashtags.map((h) => h.replace(/^#+/, "")).slice(0, 30), v.at, v.by, "Made in Creative — check and approve before it goes out."],
    );
    const postId = p.rows[0].id;
    for (const [i, f] of v.files.slice(0, 10).entries()) {
      const m = await client.query<{ id: string }>(`INSERT INTO marketing_post_media (post_id, position, kind, url) VALUES ($1::uuid, $2, $3, '') RETURNING id`, [postId, i, f.kind]);
      const mediaId = m.rows[0].id;
      const { bytes, contentType } = await getFile(f.path);
      const ext = f.kind === "video" ? "mp4" : "jpg";
      const path = `marketing/uploads/${postId}/${mediaId}.${ext}`;
      await uploadBytesToStorage({ path, bytes: new Uint8Array(bytes), contentType: contentType || (f.kind === "video" ? "video/mp4" : "image/jpeg") });
      await client.query(`UPDATE marketing_post_media SET storage_path = $2, url = $3 WHERE id = $1::uuid`, [mediaId, path, publicMediaUrl(mediaId, f.kind)]);
      if (f.cover) {
        const c = await getFile(f.cover);
        const cp = `marketing/uploads/${postId}/${mediaId}-cover-${Date.now()}.jpg`;
        await uploadBytesToStorage({ path: cp, bytes: new Uint8Array(c.bytes), contentType: "image/jpeg" });
        await client.query(`UPDATE marketing_post_media SET cover_storage_path = $2, cover_url = $3 WHERE id = $1::uuid`, [mediaId, cp, publicMediaUrl(mediaId, "image", true)]);
      }
    }
    for (const t of ["instagram", "facebook"]) await client.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`, [postId, t]);
    await client.query(
      `INSERT INTO creative_posts (post_id, tenant_id, project_id, recipe_key, model_ids, preset, music_mood, hook) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
      [postId, tenantId, v.projectId, v.meta.recipe, v.meta.models, v.meta.preset, v.meta.music, v.meta.hook],
    );
    await client.query("COMMIT");
    return postId;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
