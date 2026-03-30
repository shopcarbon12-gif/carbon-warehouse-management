import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  listStatusLabels,
  updateStatusLabelBoolean,
  type StatusLabelBooleanKey,
} from "@/lib/queries/status-labels";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

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
  includeInInventory: z.boolean().optional(),
  hideInSearchFilters: z.boolean().optional(),
  hideInItemDetails: z.boolean().optional(),
  displayInGroupPage: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

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
  const updates: { key: StatusLabelBooleanKey; value: boolean }[] = [];
  if (b.includeInInventory !== undefined) {
    updates.push({ key: "include_in_inventory", value: b.includeInInventory });
  }
  if (b.hideInSearchFilters !== undefined) {
    updates.push({ key: "hide_in_search_filters", value: b.hideInSearchFilters });
  }
  if (b.hideInItemDetails !== undefined) {
    updates.push({ key: "hide_in_item_details", value: b.hideInItemDetails });
  }
  if (b.displayInGroupPage !== undefined) {
    updates.push({ key: "display_in_group_page", value: b.displayInGroupPage });
  }
  if (updates.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    for (const u of updates) {
      const ok = await updateStatusLabelBoolean(pool, b.id, u.key, u.value);
      if (!ok) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }
    const rows = await listStatusLabels(pool);
    const row = rows.find((r) => r.id === b.id);
    return NextResponse.json(row ?? { ok: true });
  } catch (e) {
    console.error("[status-labels PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
