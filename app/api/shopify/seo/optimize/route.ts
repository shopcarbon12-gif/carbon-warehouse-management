import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { checkGenerateRateLimit } from "@/lib/seo-ratelimit";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { optimizeSeo } from "@/lib/seo/optimizeCore";
import { studioRefViewKey } from "@/lib/studio-item-spec";
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
async function POST_handler(req: NextRequest) {
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

    /* The Studio's item spec for this product, when it has one: close-up
       observations of the garment (printed wording, hardware, stitching, fit)
       that the Shopify photos may not resolve. Used ONLY when it still
       describes the photos it was computed from — the Studio itself treats a
       key mismatch as "re-analyze", and a spec written for a different set of
       photos is not evidence about this one. The photos always win on a
       conflict; see factsFromStudioSpec. */
    let verifiedFacts = "";
    const matrixId = typeof body?.matrixId === "string" ? body.matrixId.trim() : "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(matrixId)) {
      try {
        const r = await pool.query(
          `SELECT item_spec, item_refs, spec_refs_key FROM studio_matrix_state WHERE matrix_id = $1::uuid`,
          [matrixId],
        );
        const row = r.rows[0];
        const spec = String(row?.item_spec || "").trim();
        const storedKey = String(row?.spec_refs_key || "");
        const refs = Array.isArray(row?.item_refs) ? row.item_refs : [];
        if (spec && storedKey && storedKey === studioRefViewKey(refs)) verifiedFacts = spec;
      } catch {
        /* no spec — the photos alone still ground the copy */
      }
    }

    const result = await optimizeSeo({
      context,
      current,
      useVision: body?.useVision !== false,
      descriptionMode: body?.descriptionMode === "weak-only" ? "weak-only" : "photos",
      verifiedFacts,
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

export const POST = withActivity("shopify/seo/optimize", POST_handler);
