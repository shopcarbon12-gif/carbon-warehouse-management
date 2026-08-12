/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { fetchRemoteImageBytes, normalizeRemoteImageUrl, getImageFetchTimeoutMs } from "@/lib/remoteImage";
import { resolveShopContext, listProductMedia } from "@/lib/server/shopify-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Scan the product's hero image and suggest metafield values (Meta tab AI-fill).
 * Body: { matrixId } → { values: { fullDescription, gender, ageGroup, condition } }
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { matrixId?: string };
  const matrixId = body.matrixId?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const mr = await pool.query<{ shopify_product_id: string | null; description: string | null; category: string | null }>(
    `SELECT shopify_product_id, description, category FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const m = mr.rows[0];
  if (!m?.shopify_product_id) {
    return NextResponse.json({ error: "Publish the product to Shopify first." }, { status: 422 });
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return NextResponse.json({ error: "OpenAI API key not configured." }, { status: 500 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });
  const media = await listProductMedia(ctx, m.shopify_product_id);
  const hero = media[0]?.url;
  if (!hero) return NextResponse.json({ error: "No product image to scan — add a hero image first." }, { status: 422 });

  let dataUrl = "";
  try {
    const safe = normalizeRemoteImageUrl(hero);
    const { bytes, contentType } = await fetchRemoteImageBytes(safe, { timeoutMs: getImageFetchTimeoutMs() });
    dataUrl = `data:${contentType || "image/jpeg"};base64,${bytes.toString("base64")}`;
  } catch (e) {
    return NextResponse.json({ error: `Could not read the hero image: ${e instanceof Error ? e.message : "error"}` }, { status: 502 });
  }

  const openai = new OpenAI({ apiKey });
  try {
    const c: any = await openai.chat.completions.create({
      model: (process.env.SEO_MODEL || "gpt-4o").trim(),
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You classify apparel from a product photo. Return only valid JSON." },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Product name: "${m.description || ""}"${m.category ? `, category: ${m.category}` : ""}.`,
                "From the photo + name, return STRICT JSON only:",
                `{"fullDescription": string (2-3 sentence marketing description of the visible garment),`,
                ` "gender": "male" | "female" | "unisex",`,
                ` "ageGroup": "adult" | "kids" | "toddler" | "infant" | "newborn",`,
                ` "condition": "new"}`,
                "Base gender/age on the garment style; condition is 'new' unless clearly otherwise.",
              ].join("\n"),
            },
            { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(c?.choices?.[0]?.message?.content || "{}");
    const pick = (v: unknown, allowed: string[], dflt: string) => {
      const s = String(v || "").trim().toLowerCase();
      return allowed.includes(s) ? s : dflt;
    };
    return NextResponse.json({
      values: {
        fullDescription: String(parsed.fullDescription || "").trim(),
        gender: pick(parsed.gender, ["male", "female", "unisex"], ""),
        ageGroup: pick(parsed.ageGroup, ["adult", "kids", "toddler", "infant", "newborn"], "adult"),
        condition: pick(parsed.condition, ["new", "used", "refurbished"], "new"),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "AI scan failed" }, { status: 500 });
  }
}
