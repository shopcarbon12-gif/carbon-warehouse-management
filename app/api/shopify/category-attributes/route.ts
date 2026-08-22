/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { runShopifyGraphql, toProductGid } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { fetchRemoteImageBytes, normalizeRemoteImageUrl, getImageFetchTimeoutMs } from "@/lib/remoteImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Shopify category attributes (taxonomy metafields) for a product.
 *  GET  ?matrixId=      → { linked, category, attributes:[{key,label,allowed,current}] }
 *  POST { matrixId, action:"suggest" } → { suggestions: { key: [gid] } }  (gpt-4o scans hero)
 *  POST { matrixId, action:"push", values:{ key:[gid] } } → { ok, pushed }
 *
 * Category attributes live in Shopify's reserved `shopify` namespace as
 * list.metaobject_reference metafields (keys e.g. neckline, dress-style). Allowed
 * values are metaobjects of type `shopify--<key>`. Size is variant-driven → skipped.
 */
type ShopCtx = { shop: string; token: string; apiVersion: string };
type AllowedVal = { name: string; gid: string };
type AttrOut = { key: string; label: string; allowed: AllowedVal[]; current: string[] };

const SKIP_KEYS = new Set(["size"]);

function stripHtml(html: string | null | undefined): string {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}

async function resolveProductId(pool: ReturnType<typeof getPool>, matrixId: string) {
  const r = await pool!.query<{ shopify_product_id: string | null }>(
    `SELECT shopify_product_id FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  return r.rows[0]?.shopify_product_id || null;
}

type LoadResult =
  | { stale: true }
  | {
      stale?: false;
      category: { id: string; name: string } | null;
      title: string;
      description: string;
      heroUrl: string | null;
      attributes: AttrOut[];
    };

async function loadAttributes(ctx: ShopCtx, productId: string): Promise<LoadResult> {
  const gid = toProductGid(productId);
  const g = async <T,>(query: string, variables?: Record<string, unknown>): Promise<{ data: T | null }> => {
    const r = await runShopifyGraphql<T>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables });
    return { data: (r.data ?? null) as T | null };
  };

  const p = await g<{
    product?: {
      title?: string;
      descriptionHtml?: string;
      category?: { id: string; name: string } | null;
      featuredImage?: { url?: string } | null;
      metafields?: { nodes: { key: string; value: string }[] };
    } | null;
  }>(
    `query($id: ID!) {
      product(id: $id) {
        title descriptionHtml
        category { id name }
        featuredImage { url }
        metafields(namespace: "shopify", first: 60) { nodes { key value } }
      }
    }`,
    { id: gid },
  );
  const product = p.data?.product;
  if (!product) return { stale: true };

  const currentByKey = new Map<string, string[]>();
  for (const m of product.metafields?.nodes ?? []) {
    try {
      const v = JSON.parse(m.value);
      if (Array.isArray(v)) currentByKey.set(m.key, v as string[]);
    } catch {
      if (m.value?.startsWith("gid://")) currentByKey.set(m.key, [m.value]);
    }
  }
  const base = {
    title: product.title ?? "",
    description: stripHtml(product.descriptionHtml),
    heroUrl: product.featuredImage?.url ?? null,
  };
  const category = product.category ?? null;
  if (!category) return { category: null, ...base, attributes: [] };

  // Attribute names for this category.
  const c = await g<{ node?: { attributes?: { edges: { node: { name?: string } }[] } } | null }>(
    `query($id: ID!) {
      node(id: $id) { ... on TaxonomyCategory { attributes(first: 40) { edges { node { ... on TaxonomyChoiceListAttribute { name } } } } } }
    }`,
    { id: category.id },
  );
  const attrNames = (c.data?.node?.attributes?.edges ?? [])
    .map((e) => e.node?.name)
    .filter((n): n is string => !!n);

  // name → metafield key.
  const d = await g<{ metafieldDefinitions?: { edges: { node: { key: string; name: string } }[] } }>(
    `query { metafieldDefinitions(first: 200, ownerType: PRODUCT, namespace: "shopify") { edges { node { key name } } } }`,
  );
  const keyByName = new Map<string, string>();
  for (const e of d.data?.metafieldDefinitions?.edges ?? []) keyByName.set(e.node.name.trim().toLowerCase(), e.node.key);

  const keyed = attrNames
    .map((n) => ({ label: n, key: keyByName.get(n.trim().toLowerCase()) }))
    .filter((x): x is { label: string; key: string } => !!x.key && !SKIP_KEYS.has(x.key));

  if (keyed.length === 0) return { category, ...base, attributes: [] };

  // Batched metaobjects (allowed values) for all keys in one call.
  const aliases = keyed
    .map((k, i) => `a${i}: metaobjects(type: ${JSON.stringify(`shopify--${k.key}`)}, first: 250) { nodes { id displayName } }`)
    .join("\n");
  const mo = await g<Record<string, { nodes: { id: string; displayName: string }[] }>>(`query { ${aliases} }`);

  const attributes: AttrOut[] = keyed
    .map((k, i) => {
      const nodes = mo.data?.[`a${i}`]?.nodes ?? [];
      return {
        key: k.key,
        label: k.label,
        allowed: nodes.map((n) => ({ name: n.displayName, gid: n.id })),
        current: currentByKey.get(k.key) ?? [],
      };
    })
    .filter((a) => a.allowed.length > 0);

  return { category, ...base, attributes };
}

function clearStaleLink(pool: ReturnType<typeof getPool>, matrixId: string) {
  return Promise.all([
    pool!.query(`UPDATE matrices SET shopify_product_id = NULL, shopify_sync_status = NULL WHERE id = $1::uuid`, [matrixId]).catch(() => {}),
    pool!.query(`UPDATE custom_skus SET shopify_variant_id = NULL, shopify_inventory_item_id = NULL WHERE matrix_id = $1::uuid`, [matrixId]).catch(() => {}),
  ]);
}

/** AI-pick the single best Shopify taxonomy category from search candidates. */
async function pickCategory(
  openai: OpenAI,
  title: string,
  description: string,
  dataUrl: string,
  cands: Array<[string, string]>,
): Promise<string | null> {
  const list = cands.map((c, i) => `${i + 1}. ${c[1]}`).join("\n");
  const content: any[] = [
    {
      type: "text",
      text: [
        `Product: "${title}".`,
        description ? `Description: ${description}` : "",
        "Pick the single best Shopify category for this product from the numbered list.",
        "Prefer the standard adult apparel/accessory category — avoid Baby & Children's, Maternity, Costumes, and Sports-fan variants unless clearly correct.",
        'Return STRICT JSON only: {"index": <the chosen number, or 0 if none fit>}.',
        list,
      ].filter(Boolean).join("\n"),
    },
  ];
  if (dataUrl) content.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
  try {
    const c: any = await openai.chat.completions.create({
      model: (process.env.SEO_MODEL || "gpt-4o").trim(),
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You classify products into a fixed taxonomy list. Return only valid JSON." },
        { role: "user", content },
      ],
    });
    const idx = Number(JSON.parse(c?.choices?.[0]?.message?.content || "{}").index) || 0;
    if (idx >= 1 && idx <= cands.length) return cands[idx - 1][0];
  } catch {
    /* fall through — leave category unset */
  }
  return null;
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const matrixId = new URL(req.url).searchParams.get("matrixId")?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const productId = await resolveProductId(pool, matrixId);
  if (!productId) return NextResponse.json({ linked: false, category: null, attributes: [] });
  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const res = await loadAttributes(ctx, productId);
  if ("stale" in res && res.stale) {
    await clearStaleLink(pool, matrixId);
    return NextResponse.json({ error: "This product no longer exists on Shopify — the link was cleared.", code: "STALE_LINK" }, { status: 404 });
  }
  const r = res as Exclude<LoadResult, { stale: true }>;
  return NextResponse.json({ linked: true, category: r.category, attributes: r.attributes });
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
    action?: "suggest" | "push";
    values?: Record<string, string[]>;
  };
  const matrixId = body.matrixId?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const productId = await resolveProductId(pool, matrixId);
  if (!productId) return NextResponse.json({ error: "Publish/link this product to Shopify first." }, { status: 422 });
  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });
  const gid = toProductGid(productId);

  if (body.action === "push") {
    const values = body.values ?? {};
    const toSet: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
    const toDelete: Array<{ ownerId: string; namespace: string; key: string }> = [];
    for (const [key, gids] of Object.entries(values)) {
      const clean = (gids || []).filter((x) => typeof x === "string" && x.startsWith("gid://shopify/Metaobject/"));
      if (clean.length) toSet.push({ ownerId: gid, namespace: "shopify", key, type: "list.metaobject_reference", value: JSON.stringify(clean) });
      else toDelete.push({ ownerId: gid, namespace: "shopify", key });
    }
    const warnings: string[] = [];
    if (toSet.length) {
      const r = await runShopifyGraphql<{ metafieldsSet?: { userErrors?: { message: string }[] } }>({
        shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion,
        query: `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{ message } } }`,
        variables: { mf: toSet },
      });
      for (const e of r.data?.metafieldsSet?.userErrors ?? []) warnings.push(e.message);
    }
    if (toDelete.length) {
      const r = await runShopifyGraphql<{ metafieldsDelete?: { userErrors?: { message: string }[] } }>({
        shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion,
        query: `mutation($mf:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$mf){ userErrors{ message } } }`,
        variables: { mf: toDelete },
      });
      for (const e of r.data?.metafieldsDelete?.userErrors ?? []) warnings.push(e.message);
    }
    return NextResponse.json({ ok: warnings.length === 0, pushed: toSet.length, cleared: toDelete.length, warnings });
  }

  // action === "suggest"
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return NextResponse.json({ error: "OpenAI API key not configured." }, { status: 500 });
  const openai = new OpenAI({ apiKey });
  const gq = async <T,>(query: string, variables?: Record<string, unknown>): Promise<{ data: T | null }> => {
    const rr = await runShopifyGraphql<T>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables });
    return { data: (rr.data ?? null) as T | null };
  };

  const res = await loadAttributes(ctx, productId);
  if ("stale" in res && res.stale) {
    await clearStaleLink(pool, matrixId);
    return NextResponse.json({ error: "This product no longer exists on Shopify — the link was cleared.", code: "STALE_LINK" }, { status: 404 });
  }
  let r = res as Exclude<LoadResult, { stale: true }>;

  // Hero image — shared by category pick + attribute fill.
  let dataUrl = "";
  if (r.heroUrl) {
    try {
      const safe = normalizeRemoteImageUrl(r.heroUrl);
      const { bytes, contentType } = await fetchRemoteImageBytes(safe, { timeoutMs: getImageFetchTimeoutMs() });
      dataUrl = `data:${contentType || "image/jpeg"};base64,${bytes.toString("base64")}`;
    } catch {
      /* classify from title alone */
    }
  }

  // No Shopify category yet → AI-assign one so its attributes become fillable.
  let assignedCategory = false;
  if (!r.category) {
    const wms = await pool.query<{ subcategory_1: string | null }>(`SELECT subcategory_1 FROM matrices WHERE id = $1::uuid`, [matrixId]);
    const wsub = wms.rows[0]?.subcategory_1 || "";
    const titleTail = r.title.split(/\s+/).filter((w) => w.length > 2).slice(-2);
    const terms = Array.from(new Set([wsub, ...titleTail].map((s) => s.trim()).filter(Boolean))).slice(0, 3);
    const candMap = new Map<string, string>();
    for (const term of terms) {
      const t = await gq<{ taxonomy?: { categories?: { nodes: { id: string; fullName: string; isLeaf: boolean; isArchived: boolean }[] } } }>(
        `query($s:String!){ taxonomy{ categories(first:8, search:$s){ nodes{ id fullName isLeaf isArchived } } } }`,
        { s: term },
      );
      for (const n of t.data?.taxonomy?.categories?.nodes ?? []) if (n.isLeaf && !n.isArchived) candMap.set(n.id, n.fullName);
    }
    const cands = Array.from(candMap.entries()).slice(0, 20);
    if (cands.length) {
      const picked = await pickCategory(openai, r.title, r.description, dataUrl, cands);
      if (picked) {
        const up = await gq<{ productUpdate?: { userErrors?: { message: string }[] } }>(
          `mutation($id:ID!,$cat:ID!){ productUpdate(product:{ id:$id, category:$cat }){ userErrors{ message } } }`,
          { id: gid, cat: picked },
        );
        if (!(up.data?.productUpdate?.userErrors?.length)) {
          assignedCategory = true;
          const res2 = await loadAttributes(ctx, productId);
          if (!("stale" in res2 && res2.stale)) r = res2 as Exclude<LoadResult, { stale: true }>;
        }
      }
    }
  }

  // Fill attribute values from the (possibly newly-assigned) category.
  const suggestions: Record<string, string[]> = {};
  if (r.attributes.length) {
    const attrSpec = r.attributes.map((a) => `- ${a.label} (key "${a.key}"): allowed = [${a.allowed.map((v) => v.name).join(", ")}]`).join("\n");
    const content: any[] = [
      {
        type: "text",
        text: [
          `Product: "${r.title}"${r.category ? ` (category: ${r.category.name})` : ""}.`,
          r.description ? `Description: ${r.description}` : "",
          "You are classifying an apparel product for a Shopify catalog. For EACH attribute below, choose the value(s) from its allowed list that best match this product, based on the photo and the title/description.",
          "Rules: use ONLY exact values from that attribute's allowed list; if you cannot tell confidently, omit that attribute. Most attributes take a single value; color and features can take several.",
          "Return STRICT JSON only: an object mapping each attribute key to an array of chosen value names, e.g. {\"neckline\":[\"Round\"],\"dress-style\":[\"Sheath\"]}. Omit keys you are unsure about.",
          attrSpec,
        ].filter(Boolean).join("\n"),
      },
    ];
    if (dataUrl) content.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
    let parsed: Record<string, string[]> = {};
    try {
      const c: any = await openai.chat.completions.create({
        model: (process.env.SEO_MODEL || "gpt-4o").trim(),
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You classify apparel attributes strictly from provided allowed values. Return only valid JSON." },
          { role: "user", content },
        ],
      });
      parsed = JSON.parse(c?.choices?.[0]?.message?.content || "{}");
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "AI classification failed" }, { status: 500 });
    }
    for (const a of r.attributes) {
      const chosen = parsed[a.key];
      if (!Array.isArray(chosen) || !chosen.length) continue;
      const byName = new Map(a.allowed.map((v) => [v.name.trim().toLowerCase(), v.gid]));
      const gids = chosen.map((n) => byName.get(String(n).trim().toLowerCase())).filter((x): x is string => !!x);
      if (gids.length) suggestions[a.key] = Array.from(new Set(gids));
    }
  }

  return NextResponse.json({ category: r.category, attributes: r.attributes, suggestions, assignedCategory });
}
