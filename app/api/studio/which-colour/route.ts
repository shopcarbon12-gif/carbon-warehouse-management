import { withActivity } from "@/lib/server/activity-log";
/**
 * Bulk Studio › Upload: which of the product's colours a generated picture
 * actually shows. A run requested as BLACK can come out washed grey (Challenge
 * T-Shirt, 2026-10-20) — its set then belongs in GREY's block, not ahead of the
 * real black pictures. One low-detail call per run.
 *
 * POST { image: data URL, colours: string[] } → { colour: string | null }
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

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { image?: unknown; colours?: unknown; item?: unknown };
  const image = typeof body.image === "string" && body.image.startsWith("data:image/") ? body.image : "";
  const colours = (Array.isArray(body.colours) ? body.colours : []).filter((c): c is string => typeof c === "string" && c.trim() !== "").slice(0, 20);
  if (!image || colours.length < 2) return NextResponse.json({ colour: null });
  const apiKey = (getOpenAiApiKey() || "").trim();
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  try {
    const c = await new OpenAI({ apiKey }).chat.completions.create({
      model: (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o",
      temperature: 0,
      max_tokens: 40,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The product${typeof body.item === "string" && body.item ? ` (${body.item})` : ""} is sold in these colours: ${colours.join(", ")}. Look only at the product garment in the photo (not the styling pieces) and say which ONE of those colours it is. A washed or faded charcoal is GREY, not BLACK, when both are listed. JSON only: {"colour": "<one of the list>"}`,
            },
            { type: "image_url", image_url: { url: image, detail: "low" } },
          ],
        },
      ],
    });
    const pick = String((JSON.parse(c.choices?.[0]?.message?.content || "{}") as { colour?: unknown }).colour ?? "").trim().toUpperCase();
    return NextResponse.json({ colour: colours.find((x) => x.trim().toUpperCase() === pick) ?? null });
  } catch {
    return NextResponse.json({ colour: null });
  }
}

export const POST = withActivity("studio/which-colour", POST_handler);
