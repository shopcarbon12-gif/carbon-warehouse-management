import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { checkGenerateRateLimit } from "@/lib/seo-ratelimit";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { optimizeSeo } from "@/lib/seo/optimizeCore";
import type { ProductContext, SeoFields } from "@/lib/seo/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Optimize one product's SEO. The generation, repair and clamp logic lives in
 * lib/seo/optimizeCore so the bulk catalog pass runs byte-identical behaviour
 * rather than a second copy that drifts. This route is auth, rate limiting and
 * request shape.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const rate = await checkGenerateRateLimit(session.sub);
    if (!rate.success) {
      return NextResponse.json({ error: rate.error || "Too many requests." }, { status: 429 });
    }

    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured on server." }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const context = body?.context as ProductContext | undefined;
    const current = body?.current as SeoFields | undefined;
    if (!context || !current) {
      return NextResponse.json({ error: "Missing context or current SEO fields." }, { status: 400 });
    }

    const result = await optimizeSeo({
      context,
      current,
      useVision: body?.useVision !== false,
      apiKey,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    const { error: _unused, ...payload } = result;
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : "SEO optimize failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
