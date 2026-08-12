import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { resolveShopContext, setMetafields, type MetafieldInput } from "@/lib/server/shopify-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WMS → Shopify product/variant metafields (M4), confirmed scope: custom text
 * + Google-feed tiers.
 *  - custom.short_descriptions_ (multi_line_text)          → product
 *  - mm-google-shopping.gender / age_group / condition      → every variant
 * Values are persisted (matrix-level) in catalog_metafields for reload.
 *
 * GET  ?matrixId=  → { values: { fullDescription, gender, ageGroup, condition } }
 * POST { matrixId, values }  → pushes to Shopify + persists.
 */
const FIELDS = [
  { field: "fullDescription", namespace: "custom", key: "short_descriptions_" },
  { field: "gender", namespace: "mm-google-shopping", key: "gender" },
  { field: "ageGroup", namespace: "mm-google-shopping", key: "age_group" },
  { field: "condition", namespace: "mm-google-shopping", key: "condition" },
] as const;

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const matrixId = new URL(req.url).searchParams.get("matrixId")?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const r = await pool.query<{ namespace: string; key: string; value: string | null }>(
    `SELECT namespace, key, value FROM catalog_metafields
      WHERE matrix_id = $1::uuid AND custom_sku_id IS NULL`,
    [matrixId],
  );
  const values: Record<string, string> = {};
  for (const f of FIELDS) {
    const row = r.rows.find((x) => x.namespace === f.namespace && x.key === f.key);
    values[f.field] = row?.value ?? "";
  }
  return NextResponse.json({ values });
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    matrixId?: string;
    values?: Record<string, string>;
  };
  const matrixId = body.matrixId?.trim();
  const values = body.values || {};
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const m = await pool.query<{ shopify_product_id: string | null }>(
    `SELECT shopify_product_id FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const productId = m.rows[0]?.shopify_product_id;
  if (!productId) {
    return NextResponse.json({ error: "Publish the product to Shopify first." }, { status: 422 });
  }
  const variants = await pool.query<{ shopify_variant_id: string | null }>(
    `SELECT shopify_variant_id FROM custom_skus
      WHERE matrix_id = $1::uuid AND archived = FALSE AND shopify_variant_id IS NOT NULL`,
    [matrixId],
  );
  const variantIds = variants.rows.map((v) => v.shopify_variant_id!).filter(Boolean);

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const inputs: MetafieldInput[] = [];
  const fullDesc = (values.fullDescription || "").trim();
  if (fullDesc) {
    inputs.push({
      ownerId: productId,
      namespace: "custom",
      key: "short_descriptions_",
      type: "multi_line_text_field",
      value: fullDesc,
    });
  }
  for (const [key, field] of [
    ["gender", "gender"],
    ["age_group", "ageGroup"],
    ["condition", "condition"],
  ] as const) {
    const val = (values[field] || "").trim();
    if (!val) continue;
    for (const vid of variantIds) {
      inputs.push({
        ownerId: vid,
        namespace: "mm-google-shopping",
        key,
        type: "single_line_text_field",
        value: val,
      });
    }
  }

  if (!inputs.length) {
    return NextResponse.json({ error: "No metafield values provided." }, { status: 400 });
  }

  const res = await setMetafields(ctx, inputs);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });

  // Persist matrix-level values for reload.
  for (const f of FIELDS) {
    const val = (values[f.field] || "").trim();
    if (!val) continue;
    const type =
      f.field === "fullDescription" ? "multi_line_text_field" : "single_line_text_field";
    await pool.query(
      `INSERT INTO catalog_metafields (matrix_id, namespace, key, type, value)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT (matrix_id, namespace, key) WHERE matrix_id IS NOT NULL AND custom_sku_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, type = EXCLUDED.type, updated_at = now()`,
      [matrixId, f.namespace, f.key, type, val],
    );
  }

  return NextResponse.json({ ok: true, pushed: inputs.length });
}
