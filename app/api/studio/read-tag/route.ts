import { withActivity } from "@/lib/server/activity-log";
/**
 * Bulk Studio: is this photo a Carbon hang tag? If so, which product?
 *
 * A photo of the tag (barcode + custom SKU printed under it) dropped on an
 * empty item must load that product exactly as scanning the tag would, and
 * the tag photo must not become a garment reference (owner, 2026-10-20).
 * Chrome on Windows has no BarcodeDetector, so the printed SKU is read by one
 * small vision call; the SKU then resolves to the product here.
 *
 * POST { image: "data:image/…;base64,…" }
 * → { isTag: false } | { isTag: true, sku, upc, matches: [{ matrixId, name, upc }] }
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { assertDataUrlSize, getImageFetchMaxBytes } from "@/lib/remoteImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 30_000;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const PROMPT = `Is this photo a clothing store's hang tag or price tag (a small card with a barcode and a printed product code)? A garment, a model or a flat-lay photo is NOT a tag, even if a tag is visible somewhere small on it — only answer yes when the tag fills a good part of the photo and its code is readable.

If it is a tag, read:
- "sku": the product code printed under or beside the barcode, exactly, letters and digits (often starts with C followed by digits, e.g. C125213130436). No spaces.
- "upc": a separate shorter number labelled UPC, if one is printed; else "".

Reply with JSON only: {"isTag": true|false, "sku": "", "upc": ""}.`;

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { image?: unknown; code?: unknown };
  /* A code already decoded in the browser (BarcodeDetector) skips the vision call. */
  let sku = s(body.code).toUpperCase().replace(/\s+/g, "");
  let upc = "";
  if (!sku) {
    const image = s(body.image);
    if (!image.startsWith("data:image/")) return NextResponse.json({ error: "image required" }, { status: 400 });
    try {
      assertDataUrlSize(image, getImageFetchMaxBytes());
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Image too large" }, { status: 400 });
    }
    const apiKey = s(getOpenAiApiKey());
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    const client = new OpenAI({ apiKey });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const c = await client.chat.completions.create(
        {
          model: (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o",
          temperature: 0,
          max_tokens: 120,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You read product codes from photos. Output valid JSON only." },
            { role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: image, detail: "high" } }] },
          ],
        },
        { signal: ac.signal },
      );
      const j = JSON.parse(s(c.choices?.[0]?.message?.content) || "{}") as { isTag?: unknown; sku?: unknown; upc?: unknown };
      if (j.isTag !== true) return NextResponse.json({ isTag: false });
      sku = s(j.sku).toUpperCase().replace(/[^A-Z0-9]/g, "");
      upc = s(j.upc).replace(/\D/g, "");
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError" ? "Reading the tag timed out." : e instanceof Error ? e.message : "Reading the tag failed.";
      return NextResponse.json({ error: msg }, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }
  if (!sku && !upc) return NextResponse.json({ isTag: true, sku: "", upc: "", matches: [] });

  /* Exact SKU first (live rows before archived twins), then the UPC. */
  const r = await pool.query<{ matrix_id: string; name: string | null; upc: string | null; archived: boolean }>(
    `SELECT DISTINCT ON (m.id) m.id::text AS matrix_id, m.description AS name, m.upc, cs.archived
       FROM custom_skus cs JOIN matrices m ON m.id = cs.matrix_id
      WHERE ($1 <> '' AND upper(cs.sku) = $1)
      ORDER BY m.id, cs.archived`,
    [sku],
  );
  /* An archived twin row never wins over the live product holding the same SKU. */
  let rows: { matrix_id: string; name: string | null; upc: string | null }[] = r.rows.some((x) => !x.archived)
    ? r.rows.filter((x) => !x.archived)
    : r.rows;
  if (!rows.length && (upc || /^\d{6,8}$/.test(sku))) {
    const code = upc || sku;
    rows = (
      await pool.query<{ matrix_id: string; name: string | null; upc: string | null }>(
        `SELECT DISTINCT ON (m.id) m.id::text AS matrix_id, m.description AS name, m.upc
           FROM matrices m
           LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
          WHERE m.upc = $1 OR cs.upc = $1
          ORDER BY m.id`,
        [code],
      )
    ).rows;
  }
  return NextResponse.json({
    isTag: true,
    sku,
    upc,
    matches: rows.map((x) => ({ matrixId: x.matrix_id, name: x.name ?? "", upc: x.upc })),
  });
}

export const POST = withActivity("studio/read-tag", POST_handler);
