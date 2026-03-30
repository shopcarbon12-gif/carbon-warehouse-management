import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  listStatusLabels,
  insertStatusLabel,
  updateStatusLabelBoolean,
  updateStatusLabelFull,
  deleteStatusLabelById,
  type StatusLabelBooleanKey,
} from "@/lib/queries/status-labels";

async function requireAdmin() {
  const session = await getSession();
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

export async function GET() {
  const gate = await requireAdmin();
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
  includeInInventory: z.boolean().optional(),
  hideInSearchFilters: z.boolean().optional(),
  hideInItemDetails: z.boolean().optional(),
  displayInGroupPage: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const gate = await requireAdmin();
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

const postSchema = z.object({
  name: z.string().min(1).max(512).trim(),
  legacyId: z.union([z.number().int().positive(), z.null()]).optional(),
  includeInInventory: z.boolean().optional(),
  hideInSearchFilters: z.boolean().optional(),
  hideInItemDetails: z.boolean().optional(),
  displayInGroupPage: z.boolean().optional(),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;
  const { pool } = gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  const input = {
    legacy_id: b.legacyId ?? null,
    name: b.name,
    include_in_inventory: b.includeInInventory ?? false,
    hide_in_search_filters: b.hideInSearchFilters ?? false,
    hide_in_item_details: b.hideInItemDetails ?? false,
    display_in_group_page: b.displayInGroupPage ?? false,
  };

  try {
    const result = await insertStatusLabel(pool, input);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.code === "duplicate_legacy" ? "Legacy ID already in use" : "Name already exists" },
        { status: 409 },
      );
    }
    const rows = await listStatusLabels(pool);
    const row = rows.find((r) => r.id === result.id);
    return NextResponse.json(row ?? { id: result.id }, { status: 201 });
  } catch (e) {
    console.error("[status-labels POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}

const putSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(512).trim(),
  legacyId: z.union([z.number().int().positive(), z.null()]).optional(),
  includeInInventory: z.boolean(),
  hideInSearchFilters: z.boolean(),
  hideInItemDetails: z.boolean(),
  displayInGroupPage: z.boolean(),
});

export async function PUT(req: Request) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;
  const { pool } = gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  const input = {
    legacy_id: b.legacyId ?? null,
    name: b.name,
    include_in_inventory: b.includeInInventory,
    hide_in_search_filters: b.hideInSearchFilters,
    hide_in_item_details: b.hideInItemDetails,
    display_in_group_page: b.displayInGroupPage,
  };

  try {
    const result = await updateStatusLabelFull(pool, b.id, input);
    if (!result.ok) {
      if (result.code === "not_found") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: result.code === "duplicate_legacy" ? "Legacy ID already in use" : "Name already exists" },
        { status: 409 },
      );
    }
    const rows = await listStatusLabels(pool);
    const row = rows.find((r) => r.id === b.id);
    return NextResponse.json(row ?? { ok: true });
  } catch (e) {
    console.error("[status-labels PUT]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;
  const { pool } = gate;

  const idRaw = new URL(req.url).searchParams.get("id");
  const id = idRaw ? Number.parseInt(idRaw, 10) : NaN;
  if (!Number.isFinite(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const ok = await deleteStatusLabelById(pool, id);
    if (!ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[status-labels DELETE]", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
