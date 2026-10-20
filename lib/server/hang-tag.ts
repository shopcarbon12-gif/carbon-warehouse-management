import type OpenAI from "openai";
import type { Pool } from "pg";

/**
 * Carbon hang tags (Bulk Studio, owner 2026-10-20): read the product code off a
 * photo of the tag, and find the product it names.
 */
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const PROMPT = `Is this photo a clothing store's hang tag or price tag (a small card with a barcode and a printed product code)? A garment, a model or a flat-lay photo is NOT a tag, even if a tag is visible somewhere small on it — only answer yes when the tag fills a good part of the photo and its code is readable.

If it is a tag, read:
- "sku": the product code printed under or beside the barcode, exactly, letters and digits (often starts with C followed by digits, e.g. C125213130436). No spaces.
- "upc": a separate shorter number labelled UPC, if one is printed; else "".

Reply with JSON only: {"isTag": true|false, "sku": "", "upc": ""}.`;

export async function readTagPhoto(
  client: OpenAI,
  model: string,
  dataUrl: string,
  signal?: AbortSignal,
): Promise<{ isTag: boolean; sku: string; upc: string }> {
  const c = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You read product codes from photos. Output valid JSON only." },
        { role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: dataUrl, detail: "high" } }] },
      ],
    },
    { signal },
  );
  const j = JSON.parse(s(c.choices?.[0]?.message?.content) || "{}") as { isTag?: unknown; sku?: unknown; upc?: unknown };
  if (j.isTag !== true) return { isTag: false, sku: "", upc: "" };
  return { isTag: true, sku: s(j.sku).toUpperCase().replace(/[^A-Z0-9]/g, ""), upc: s(j.upc).replace(/\D/g, "") };
}

export type TagMatch = { matrixId: string; name: string; upc: string | null };

/** Exact SKU first (live rows before archived twins), then the UPC. */
export async function resolveTagCode(pool: Pool, skuIn: string, upcIn: string): Promise<TagMatch[]> {
  const sku = s(skuIn).toUpperCase().replace(/\s+/g, "");
  const upc = s(upcIn);
  if (!sku && !upc) return [];
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
  return rows.map((x) => ({ matrixId: x.matrix_id, name: x.name ?? "", upc: x.upc }));
}
