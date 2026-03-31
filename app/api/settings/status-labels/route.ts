import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { listStatusLabels, updateStatusLabelPresentation } from "@/lib/queries/status-labels";

async function requireAdmin(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const pool = getPool();
  if (!pool) {
    return { response: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  }
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { response: denied };
  return { session, pool };
}

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const { pool } = gate;

  try {
    const rows = await listStatusLabels(pool);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[status-labels GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

const patchSchema = z.object({
  id: z.number().int().positive(),
  displayLabel: z.string().max(512).optional(),
  legacyId: z.union([z.number().int().positive(), z.null()]).optional(),
});

/** Clean 10: only presentation fields (display label + legacy id) are editable. */
export async function PATCH(req: Request) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const { pool } = gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  if (b.displayLabel === undefined && b.legacyId === undefined) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const rows = await listStatusLabels(pool);
  const row = rows.find((r) => r.id === b.id);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const displayLabel = b.displayLabel !== undefined ? b.displayLabel : row.display_label;
  const legacyId = b.legacyId !== undefined ? b.legacyId : row.legacy_id;

  try {
    const ok = await updateStatusLabelPresentation(pool, b.id, {
      display_label: displayLabel,
      legacy_id: legacyId,
    });
    if (!ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const next = await listStatusLabels(pool);
    const out = next.find((r) => r.id === b.id);
    return NextResponse.json(out ?? { ok: true });
  } catch (e) {
    console.error("[status-labels PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
