/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Per-colourway Studio state: the one photo of this colour, the colour name the
 * render has to hit, and the pose/expression seed.
 *
 * The product analysis stays per MATRIX (/api/studio/state) because construction,
 * text, hardware placement and the zone map do not change with the dye. Only
 * these three things are per colour.
 *
 *   GET  /api/studio/color-run?matrixId=<uuid>            → every colour on file
 *   PUT  /api/studio/color-run  { matrixId, color, … }    → upsert one colour
 *
 * Keyed on (matrixId, color) and never on the UPC: matrices.upc is not unique
 * and the same SKU lives in several matrices, so a UPC key would hand one
 * product's photos to another.
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
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export type ColorRun = {
  color: string;
  colorRefUrl: string;
  colorName: string;
  hardwareNote: string;
  variationSeed: number;
};

async function authed(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}

function rowToRun(row: any): ColorRun {
  return {
    color: row.color ?? "",
    colorRefUrl: row.color_ref_url ?? "",
    colorName: row.color_name ?? "",
    hardwareNote: row.hardware_note ?? "",
    variationSeed: Number(row.variation_seed) || 0,
  };
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const matrixId = String(new URL(req.url).searchParams.get("matrixId") || "").trim();
  if (!UUID_RE.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const r = await a.pool.query(
    `SELECT color, color_ref_url, color_name, hardware_note, variation_seed
       FROM studio_color_runs WHERE matrix_id = $1::uuid ORDER BY color`,
    [matrixId],
  );
  return NextResponse.json({ runs: r.rows.map(rowToRun) });
}

export async function PUT(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const matrixId = str(body?.matrixId, 64);
  const color = str(body?.color, 120);
  if (!UUID_RE.test(matrixId)) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  if (!color) return NextResponse.json({ error: "color required" }, { status: 400 });

  const exists = await a.pool.query(`SELECT 1 FROM matrices WHERE id = $1::uuid LIMIT 1`, [matrixId]);
  if (!exists.rowCount) return NextResponse.json({ error: "Unknown product" }, { status: 404 });

  const colorRefUrl = str(body?.colorRefUrl, 2048);
  if (colorRefUrl && !/^https?:\/\//i.test(colorRefUrl)) {
    // A data URL is a preview, never the reference itself; storing one would
    // bloat the row and break the generator, which re-fetches by URL.
    return NextResponse.json({ error: "colorRefUrl must be a stored https URL" }, { status: 400 });
  }

  /* A seed the operator did not choose is chosen once, here, and kept. Deriving
     it from the clock on every run would make "different poses from the other
     colours" a coin toss, and would move a colour's poses every time it was
     regenerated. Existing seeds are never overwritten. */
  const incomingSeed = Number(body?.variationSeed);
  const seed =
    Number.isFinite(incomingSeed) && incomingSeed > 0
      ? Math.floor(incomingSeed) % 100000
      : null;
  /* Computed here rather than in SQL: Postgres `abs(hashtext(...))` overflows
     on INT_MIN, and concatenating a uuid-cast parameter with text makes the
     driver guess at types. A plain string hash has neither problem and gives
     each colourway of each product its own stable starting point. */
  const defaultSeed = (() => {
    const key = `${matrixId}:${color.toLowerCase()}`;
    let h = 2166136261;
    for (let i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % 100000;
  })();

  const r = await a.pool.query(
    `INSERT INTO studio_color_runs
       (matrix_id, color, tenant_id, updated_by, color_ref_url, color_name, hardware_note, variation_seed, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, COALESCE($8::integer, $9::integer), now())
     ON CONFLICT (matrix_id, color) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       updated_by = EXCLUDED.updated_by,
       color_ref_url = EXCLUDED.color_ref_url,
       color_name = EXCLUDED.color_name,
       hardware_note = EXCLUDED.hardware_note,
       -- Keep the seed this colour already had: regenerating must not reshuffle
       -- the poses the operator has already looked at.
       variation_seed = COALESCE($8::integer, studio_color_runs.variation_seed),
       updated_at = now()
     RETURNING color, color_ref_url, color_name, hardware_note, variation_seed`,
    [
      matrixId,
      color,
      UUID_RE.test(String(a.session.tid || "")) ? a.session.tid : null,
      UUID_RE.test(String(a.session.sub || "")) ? a.session.sub : null,
      colorRefUrl || null,
      str(body?.colorName, 120) || null,
      str(body?.hardwareNote, 600) || null,
      seed,
      defaultSeed,
    ],
  );
  return NextResponse.json({ ok: true, run: rowToRun(r.rows[0]) });
}

export async function DELETE(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const url = new URL(req.url);
  const matrixId = String(url.searchParams.get("matrixId") || "").trim();
  const color = String(url.searchParams.get("color") || "").trim();
  if (!UUID_RE.test(matrixId) || !color) {
    return NextResponse.json({ error: "matrixId and color required" }, { status: 400 });
  }
  await a.pool.query(`DELETE FROM studio_color_runs WHERE matrix_id = $1::uuid AND color = $2`, [matrixId, color]);
  return NextResponse.json({ ok: true });
}
