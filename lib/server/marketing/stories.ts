/**
 * Social — Stories (owner, 2026-10-26: "do it"; the social skill: Stories
 * every day keep the account at the top of the feed).
 *
 * For each coming feed post (single picture or carousel) that has no Story
 * yet, make one: its campaign shot as a 9:16 Story with the tagged product's
 * name and price (story-image.tsx), the same day in the evening (the best
 * evening hour of Instagram followers for that weekday, after the post),
 * to Instagram and Facebook. Each Story is a draft that needs its own approval,
 * like every post. source_ref "story:<feed post id>" links it to its post.
 */
import type { Pool } from "pg";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";
import { catalogProductInfo } from "./meta";
import { publicMediaUrl } from "./store";
import { renderStoryImage } from "./story-image";
import { etLocalToIso } from "./ai-changes";
import { campaignStoryLine } from "./campaign-identity";

type Feed = { id: string; title: string; campaign: string | null; at: Date; day: string; weekday: number; hour: number; storage_path: string | null };

export async function makeStories(pool: Pool, tenantId: string, by: string | null): Promise<{ created: number; skipped: string[] }> {
  const feed = (
    await pool.query<Feed>(
      `SELECT p.id, p.title, p.campaign, p.scheduled_at AS at,
              to_char(p.scheduled_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS day,
              extract(dow FROM p.scheduled_at AT TIME ZONE 'America/New_York')::int AS weekday,
              extract(hour FROM p.scheduled_at AT TIME ZONE 'America/New_York')::int AS hour,
              (SELECT m.storage_path FROM marketing_post_media m WHERE m.post_id = p.id AND m.kind = 'image' ORDER BY m.position LIMIT 1) AS storage_path
         FROM marketing_posts p
        WHERE p.tenant_id = $1::uuid AND p.format IN ('image', 'carousel') AND p.status NOT IN ('cancelled', 'published')
          AND p.scheduled_at > now()
          AND NOT EXISTS (SELECT 1 FROM marketing_posts s WHERE s.tenant_id = p.tenant_id AND s.source_ref = 'story:' || p.id::text AND s.status <> 'cancelled')
        ORDER BY p.scheduled_at`,
      [tenantId],
    )
  ).rows;
  const best = (
    await pool.query<{ weekday: number; hour: number; score: number }>(
      `SELECT weekday, hour, score::float AS score FROM marketing_best_times WHERE tenant_id = $1::uuid AND provider = 'instagram' AND hour BETWEEN 17 AND 21`,
      [tenantId],
    )
  ).rows;
  const skipped: string[] = [];
  let created = 0;
  for (const f of feed) {
    if (!f.storage_path) {
      skipped.push(`${f.title}: no picture`);
      continue;
    }
    const tag = (
      await pool.query<{ meta_product_id: string; label: string; x: number; y: number }>(
        // The main garment: shoes and bags only when nothing else is tagged, then the tag nearest the middle.
        `SELECT meta_product_id, label, x::float AS x, y::float AS y FROM marketing_post_tags WHERE post_id = $1::uuid AND media_position = 0
          ORDER BY (label ~* '(heel|sneaker|shoe|boot|sandal|loafer|bag)') ASC, abs(x - 0.5) + abs(y - 0.45) ASC, id LIMIT 1`,
        [f.id],
      )
    ).rows[0];
    if (!tag) {
      skipped.push(`${f.title}: no product tag on the first picture`);
      continue;
    }
    try {
      const info = await catalogProductInfo(tag.meta_product_id).catch(() => ({ name: tag.label, price: null }));
      const photo = Buffer.from((await downloadStorageObject(f.storage_path)).body);
      const jpg = await renderStoryImage(photo, { x: tag.x, y: tag.y }, { name: info.name || tag.label, price: info.price, topLine: campaignStoryLine(f.campaign) });
      // The weekday's best evening hour, after the feed post (at least 2 hours later), by 10 PM.
      const evening = best.filter((b) => b.weekday === f.weekday).sort((a, b) => b.score - a.score)[0]?.hour ?? 20;
      const hour = Math.min(22, Math.max(evening, f.hour + 2));
      const at = etLocalToIso(`${f.day}T${String(hour).padStart(2, "0")}:00`);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const p = await client.query<{ id: string }>(
          `INSERT INTO marketing_posts (tenant_id, campaign, source_ref, title, format, caption, hashtags, scheduled_at, status, created_by)
           VALUES ($1::uuid, $2, $3, $4, 'story', '', '{}', $5, 'draft', $6) RETURNING id`,
          [tenantId, f.campaign, `story:${f.id}`, `Story · ${f.title}`, at, by],
        );
        const postId = p.rows[0].id;
        const m = await client.query<{ id: string }>(`INSERT INTO marketing_post_media (post_id, position, kind, url) VALUES ($1::uuid, 0, 'image', '') RETURNING id`, [postId]);
        const path = `marketing/stories/${postId}/${m.rows[0].id}.jpg`;
        await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
        await client.query(`UPDATE marketing_post_media SET storage_path = $2, url = $3 WHERE id = $1::uuid`, [m.rows[0].id, path, publicMediaUrl(m.rows[0].id, "image")]);
        for (const t of ["instagram", "facebook"]) await client.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1::uuid, $2)`, [postId, t]);
        await client.query("COMMIT");
        created++;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      skipped.push(`${f.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { created, skipped };
}
