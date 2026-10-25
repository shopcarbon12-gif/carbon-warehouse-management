/**
 * POST /api/marketing/ai/write { postId, brief? } — "Write with AI": title,
 * caption, hashtags and product tags for a Social post from its pictures
 * (lib/server/marketing/ai-write.ts). Returns a suggestion; nothing is saved.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts } from "@/lib/server/marketing/store";
import { writePost } from "@/lib/server/marketing/ai-write";
import { claudeConfigured } from "@/lib/server/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({ postId: z.string().uuid(), brief: z.string().max(2000).default("") }).strict();

export async function POST(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Which post?" }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 503 });
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [parsed.data.postId] });
  if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  if (!post.media.length) return NextResponse.json({ error: "Add a picture first — the AI writes from the pictures" }, { status: 400 });
  try {
    return NextResponse.json({ suggestion: await writePost(g.pool, g.session.tid, post, parsed.data.brief) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The AI could not write it" }, { status: 502 });
  }
}
