import { withActivity } from "@/lib/server/activity-log";
/**
 * Bulk Studio › Upload: which view each current Shopify picture shows, so the
 * product's existing pictures can be put in the owner's order too (full-length
 * front first, close-ups and details, seated, back last). Eight pictures per
 * low-detail call — a fraction of a cent per product. Cached per picture.
 *
 * POST { urls: string[] } → { views: ("full-front"|"front-close"|"side"|"detail"|"seated"|"back-close"|"back"|"other")[] }
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABELS = ["full-front", "front-close", "side", "detail", "seated", "back-close", "back", "other"] as const;
type View = (typeof LABELS)[number];
const cache = new Map<string, View>();
const key = (u: string) => u.split("?")[0];

const PROMPT = `Each photo is from a clothing store's product gallery. For each, give ONE label for the view it shows of the product:
- "full-front": the whole person head-to-toe (or the whole garment) facing the camera
- "front-close": a front crop or close-up (waist up, torso, chest, waist to knee) — clearly the front
- "side": a full-length side / three-quarter turned view
- "detail": a close-up of a label, fabric, neckline, hardware, print or stitching
- "seated": a person sitting
- "back-close": a back crop or over-the-shoulder back view (not full length)
- "back": the full-length back
- "other": anything else
JSON only: {"labels": ["...", ...]} in the same order as the photos.`;

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { urls?: unknown };
  const urls = (Array.isArray(body.urls) ? body.urls : []).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 100);
  const apiKey = (getOpenAiApiKey() || "").trim();
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  const client = new OpenAI({ apiKey });
  const todo = urls.filter((u) => !cache.has(key(u)));
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += 8) batches.push(todo.slice(i, i + 8));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const sized = batch.map((u) => (/cdn\.shopify\.com/.test(u) ? `${key(u)}?width=512` : u));
        const c = await client.chat.completions.create({
          model: (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o",
          temperature: 0,
          max_tokens: 200,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, ...sized.map((u) => ({ type: "image_url" as const, image_url: { url: u, detail: "low" as const } }))] }],
        });
        const labels = (JSON.parse(c.choices?.[0]?.message?.content || "{}") as { labels?: unknown[] }).labels ?? [];
        batch.forEach((u, i) => cache.set(key(u), (LABELS as readonly string[]).includes(String(labels[i])) ? (labels[i] as View) : "other"));
      } catch {
        /* left unclassified — keeps its place */
      }
    }),
  );
  return NextResponse.json({ views: urls.map((u) => cache.get(key(u)) ?? "other") });
}

export const POST = withActivity("studio/classify-views", POST_handler);
