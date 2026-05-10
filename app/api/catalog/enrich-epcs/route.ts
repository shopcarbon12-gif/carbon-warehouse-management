import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { enrichEpcsByCatalog } from "@/lib/server/catalog-enrich";

/**
 * Pure-read SKU enrichment for a list of EPCs. Decodes each against the
 * tenant's bit layout, joins to `custom_skus` by `ls_system_id`, and
 * returns SKU / name / color / size / UPC / vendor / retail price.
 *
 * Distinct from `/api/operations/transfers/lookup` in one critical way:
 * **this endpoint does NOT mutate `items`.** The transfers/lookup
 * endpoint has a deliberate side effect (auto-ingest unknown EPCs as
 * status='in-stock' or 'tag_killed') because the Transfer Out flow
 * needs that to commission tags on the fly. The Antenna Test workspace
 * (and any future read-only diagnostic view) should NOT have that side
 * effect — running a test shouldn't silently grow inventory.
 *
 * Body:
 *   { epcs: string[] }   // 1..200
 * Response:
 *   { rows: CatalogEnrichRow[] }
 *
 * Status field semantics differ from items.status:
 *   - 'in-stock'    — decoded + catalog match (would land in-stock if ingested)
 *   - 'unknown'     — decoded + no catalog match (no item ever created)
 *   - 'undecodable' — wrong length / non-hex / wrong tenant prefix
 */

const bodySchema = z.object({
  epcs: z.array(z.string()).min(1).max(200),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const rows = await enrichEpcsByCatalog(pool, session.tid, parsed.data.epcs);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[catalog/enrich-epcs]", e);
    return NextResponse.json({ error: "Enrichment failed" }, { status: 500 });
  }
}
