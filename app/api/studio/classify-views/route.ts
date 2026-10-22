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
import { classifyPhotoViews, photoKey, type PhotoView } from "@/lib/server/photo-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type View = PhotoView;
const cache = new Map<string, View>();
const key = photoKey;

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
  for (const [k, v] of await classifyPhotoViews(client, todo)) cache.set(k, v);
  return NextResponse.json({ views: urls.map((u) => cache.get(key(u)) ?? "other") });
}

export const POST = withActivity("studio/classify-views", POST_handler);
