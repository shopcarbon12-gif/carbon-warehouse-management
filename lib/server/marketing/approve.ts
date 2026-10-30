/**
 * Approving Social posts on the server (owner, 2026-10-29). Approve no longer
 * waits in the open panel for the caption check: a press that moved on before
 * the check finished was silently dropped (Day 9). Used by the post's Approve
 * button and by "Approve all" for a date range (Stories / Reels / Posts / all).
 *
 * Every post is checked first: picture, a time still ahead, channels
 * connected, the AI not busy on it, and its product tags still taggable in
 * Meta. A Story is then approved. A post or Reel is approved when its caption
 * (exactly as saved) already passed the caption check; otherwise the check is
 * queued and approves it by itself when it passes (ai-jobs.ts).
 */
import type { Pool } from "pg";
import { enqueueAiJob } from "./ai-jobs";
import { untaggableProducts } from "./meta";
import { listPosts, type MarketingPost } from "./store";

export type ApproveOutcome = { id: string; title: string; when: string | null; result: "approved" | "checking" | "blocked"; reason?: string };

const OPEN = ["draft", "changes_requested"];

export async function approveNow(pool: Pool, postId: string, by: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE marketing_posts SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
      WHERE id = $1::uuid AND status = ANY($3::text[])`,
    [postId, by, OPEN],
  );
  if (r.rowCount) await pool.query(`UPDATE marketing_post_targets SET status = 'pending', attempts = 0, error = NULL WHERE post_id = $1::uuid AND status = 'failed'`, [postId]);
  return Boolean(r.rowCount);
}

export async function approvePost(pool: Pool, tenantId: string, post: MarketingPost, by: string): Promise<ApproveOutcome> {
  const out = (result: ApproveOutcome["result"], reason?: string): ApproveOutcome => ({ id: post.id, title: post.title, when: post.scheduledAt, result, reason });
  if (!OPEN.includes(post.status)) return out("blocked", post.status === "approved" ? "already approved" : `it is ${post.status}`);
  if (post.aiStatus === "queued" || post.aiStatus === "working" || post.aiStatus === "picture") return out("blocked", "the AI is still making the changes asked for");
  if (!post.scheduledAt) return out("blocked", "no date and time");
  if (new Date(post.scheduledAt).getTime() < Date.now()) return out("blocked", "its time has already passed — pick a new time");
  if (!post.media.length) return out("blocked", "no picture or video");
  const targets = post.targets.map((t) => t.provider);
  if (!targets.length) return out("blocked", "no channel picked");
  const connected = await pool.query<{ provider: string }>(
    `SELECT DISTINCT provider FROM marketing_channels WHERE tenant_id = $1::uuid AND status = 'connected' AND provider = ANY($2::text[])`,
    [tenantId, targets],
  );
  const missing = targets.filter((t) => !connected.rows.some((r) => r.provider === t));
  if (missing.length) return out("blocked", `${missing.join(" and ")} is not connected`);
  if (post.format === "reel" && !post.media.some((m) => m.kind === "video")) return out("blocked", "a Reel needs its video");
  if (targets.includes("instagram") && post.tags.length) {
    const bad = await untaggableProducts(post.tags.map((t) => t.metaProductId)).catch(() => []);
    if (bad.length) {
      const names = bad.map((b) => post.tags.find((t) => t.metaProductId === b.id)?.label ?? b.id);
      return out("blocked", `Instagram would refuse these tags (hidden in Meta): ${names.join(", ")}`);
    }
  }
  // A Story has no caption on Instagram or Facebook: nothing to check.
  if (post.format === "story" || !post.caption.trim()) return (await approveNow(pool, post.id, by)) ? out("approved") : out("blocked", "it changed meanwhile");

  const hashtags = post.hashtags.map((h) => h.replace(/^#+/, ""));
  const last = await pool.query<{ status: string; result: { ok?: boolean; issues?: { rule: string }[] } | null }>(
    `SELECT status, result FROM marketing_ai_jobs
      WHERE post_id = $1::uuid AND kind = 'check' AND input->>'caption' = $2 AND input->'hashtags' = $3::jsonb
      ORDER BY created_at DESC LIMIT 1`,
    [post.id, post.caption, JSON.stringify(hashtags)],
  );
  const c = last.rows[0];
  if (c?.status === "done" && c.result?.ok) return (await approveNow(pool, post.id, by)) ? out("approved") : out("blocked", "it changed meanwhile");
  if (c?.status === "done" && c.result && !c.result.ok)
    return out("blocked", `the caption check found: ${(c.result.issues ?? []).map((i) => i.rule).join("; ") || "problems"} — open it to fix, or "Approve as it is"`);
  await enqueueAiJob(pool, { tenantId, postId: post.id, kind: "check", input: { caption: post.caption, hashtags, approveWhenOk: true, approvedBy: by }, by });
  return out("checking");
}

export type ApproveKind = "story" | "reel" | "post" | "all";

/** Approve every open post of a kind whose time falls in [fromDay, toDay] (Eastern dates, inclusive). */
export async function approveRange(pool: Pool, tenantId: string, kind: ApproveKind, fromDay: string, toDay: string, by: string): Promise<ApproveOutcome[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text FROM marketing_posts
      WHERE tenant_id = $1::uuid AND status = ANY($2::text[]) AND scheduled_at IS NOT NULL
        AND (scheduled_at AT TIME ZONE 'America/New_York')::date BETWEEN $3::date AND $4::date
        AND ($5 = 'all' OR ($5 = 'story' AND format = 'story') OR ($5 = 'reel' AND format = 'reel') OR ($5 = 'post' AND format IN ('image', 'carousel')))
      ORDER BY scheduled_at`,
    [tenantId, OPEN, fromDay, toDay, kind],
  );
  if (!r.rows.length) return [];
  const posts = await listPosts(pool, tenantId, { ids: r.rows.map((x) => x.id) });
  const out: ApproveOutcome[] = [];
  for (const p of posts) out.push(await approvePost(pool, tenantId, p, by));
  return out;
}
