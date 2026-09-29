/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Per-product Studio working state: the item reference photos with their
 * General / Front / Back sorting, the reviewed item spec, and the "back is
 * plain" check. Before this, closing the product modal threw all of it away —
 * and the photos that came back on reopen were the product's PUBLISHED
 * images, i.e. the previous AI renders, silently fed in as references.
 *
 *   GET  /api/studio/state?matrixId=<uuid>
 *   PUT  /api/studio/state   { matrixId, itemRefs, itemType, instruction,
 *                              itemSpec, specRefsKey, specConfirmed, backIsPlain }
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS = new Set(["general", "front", "back"]);
const MAX_REFS = 40;

type StoredRef = { url: string; view: "general" | "front" | "back" };

function sanitizeRefs(v: unknown): StoredRef[] {
  if (!Array.isArray(v)) return [];
  const out: StoredRef[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const url = typeof (x as any).url === "string" ? (x as any).url.trim() : "";
    const view = typeof (x as any).view === "string" ? (x as any).view : "general";
    // Only stored (https) references survive a reload; a data URL is a
    // preview, never the reference itself, and would bloat the row.
    if (!url || !/^https?:\/\//i.test(url) || url.length > 2048) continue;
    out.push({ url, view: VIEWS.has(view) ? (view as StoredRef["view"]) : "general" });
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function authed(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const matrixId = String(new URL(req.url).searchParams.get("matrixId") || "").trim();
  if (!UUID_RE.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const r = await a.pool.query(
    `SELECT item_refs, item_type, instruction, item_spec, spec_refs_key, spec_confirmed, back_is_plain, updated_at
       FROM studio_matrix_state WHERE matrix_id = $1::uuid`,
    [matrixId]
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ state: null });
  return NextResponse.json({
    state: {
      itemRefs: sanitizeRefs(row.item_refs),
      itemType: row.item_type ?? "",
      instruction: row.instruction ?? "",
      itemSpec: row.item_spec ?? "",
      specRefsKey: row.spec_refs_key ?? "",
      specConfirmed: row.spec_confirmed === true,
      backIsPlain: row.back_is_plain === true,
      updatedAt: row.updated_at,
    },
  });
}

export async function PUT(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const matrixId = str(body?.matrixId, 64);
  if (!UUID_RE.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const itemRefs = sanitizeRefs(body?.itemRefs);
  const itemSpec = str(body?.itemSpec, 8000);
  // Only for a product that exists — no rows for made-up ids.
  const exists = await a.pool.query(`SELECT 1 FROM matrices WHERE id = $1::uuid LIMIT 1`, [matrixId]);
  if (!exists.rowCount) return NextResponse.json({ error: "Unknown product" }, { status: 404 });
  await a.pool.query(
    `INSERT INTO studio_matrix_state
       (matrix_id, tenant_id, updated_by, item_refs, item_type, instruction, item_spec, spec_refs_key, spec_confirmed, back_is_plain, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (matrix_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       updated_by = EXCLUDED.updated_by,
       item_refs = EXCLUDED.item_refs,
       item_type = EXCLUDED.item_type,
       instruction = EXCLUDED.instruction,
       item_spec = EXCLUDED.item_spec,
       spec_refs_key = EXCLUDED.spec_refs_key,
       spec_confirmed = EXCLUDED.spec_confirmed,
       back_is_plain = EXCLUDED.back_is_plain,
       updated_at = now()`,
    [
      matrixId,
      UUID_RE.test(String(a.session.tid || "")) ? a.session.tid : null,
      UUID_RE.test(String(a.session.sub || "")) ? a.session.sub : null,
      JSON.stringify(itemRefs),
      str(body?.itemType, 120) || null,
      str(body?.instruction, 1200) || null,
      itemSpec || null,
      // 40 refs × ~250-char CDN URLs; a truncated key would read as "photos
      // changed" forever.
      str(body?.specRefsKey, 32000) || null,
      body?.specConfirmed === true,
      body?.backIsPlain === true,
    ]
  );
  return NextResponse.json({ ok: true, refs: itemRefs.length });
}
