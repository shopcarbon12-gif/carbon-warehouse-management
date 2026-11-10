/**
 * POST /api/creative/render/upload?gen=<id>&kind=video|poster&sig=<hmac> — the render worker hands
 * back a finished MP4 (and its poster). Signed with the server secret per generation id; no
 * session (the worker has none). Machine traffic: not in Activity history.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { putFile } from "@/lib/server/creative/storage";
import { uploadSig } from "@/lib/server/creative/render-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const u = new URL(req.url);
  const gen = u.searchParams.get("gen") ?? "";
  const kind = u.searchParams.get("kind") === "poster" ? "poster" : "video";
  const sig = u.searchParams.get("sig") ?? "";
  const pool = getPool();
  if (!pool || !/^[0-9a-f-]{36}$/.test(gen)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const want = uploadSig(gen);
  if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const g = (await pool.query<{ project_id: string; size: string | null; status: string }>(`SELECT project_id::text, size, status FROM creative_generations WHERE id = $1::uuid AND kind = 'render'`, [gen])).rows[0];
  if (!g || !["running", "queued"].includes(g.status)) return NextResponse.json({ error: "not running" }, { status: 409 });
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > 500 * 1024 * 1024) return NextResponse.json({ error: "bad file" }, { status: 400 });
  const path = await putFile(`creative/projects/${g.project_id}/render-${(g.size ?? "x").replace(":", "x")}-${gen.slice(0, 8)}.${kind === "poster" ? "jpg" : "mp4"}`, bytes, kind === "poster" ? "image/jpeg" : "video/mp4");
  if (kind === "poster") {
    await pool.query(`UPDATE creative_generations SET output_meta = COALESCE(output_meta, '{}'::jsonb) || jsonb_build_object('poster', $2::text), status = CASE WHEN output_path IS NOT NULL THEN 'done' ELSE status END, updated_at = now() WHERE id = $1::uuid`, [gen, path]);
  } else {
    const duration = Number(u.searchParams.get("duration") ?? 0) || null;
    await pool.query(`UPDATE creative_generations SET output_path = $2, output_meta = COALESCE(output_meta, '{}'::jsonb) || jsonb_build_object('duration', $3::float), updated_at = now() WHERE id = $1::uuid`, [gen, path, duration]);
  }
  return NextResponse.json({ ok: true, path });
}
