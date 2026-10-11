import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { cleanGroupInput, loadAdGroups } from "@/lib/server/ad-product-groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ad product groups (Integrations → Shopify → Sync ads). */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  return NextResponse.json({ groups: await loadAdGroups(pool) }, { headers: { "Cache-Control": "no-store" } });
}

/** Create (no id) or update (id) a group. */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  let g;
  try {
    g = cleanGroupInput(raw);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid group" }, { status: 400 });
  }
  const id = typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : null;
  const cols = [
    g.slug, g.name, JSON.stringify(g.product_types), JSON.stringify(g.name_contains), JSON.stringify(g.name_excludes),
    JSON.stringify(g.include_groups), g.in_stock_only, g.google_label_slot, g.google_label_value, g.meta_set_name,
    g.active, g.sort_order,
  ];
  try {
    if (id) {
      await pool.query(
        `UPDATE ad_product_groups SET slug=$2, name=$3, product_types=$4::jsonb, name_contains=$5::jsonb, name_excludes=$6::jsonb,
                include_groups=$7::jsonb, in_stock_only=$8, google_label_slot=$9, google_label_value=$10, meta_set_name=$11,
                active=$12, sort_order=$13, updated_at=now()
          WHERE id = $1::uuid`,
        [id, ...cols],
      );
    } else {
      await pool.query(
        `INSERT INTO ad_product_groups (slug, name, product_types, name_contains, name_excludes, include_groups, in_stock_only,
                google_label_slot, google_label_value, meta_set_name, active, sort_order)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
        cols,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: /unique/i.test(msg) ? "Another group already has that name" : msg },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, groups: await loadAdGroups(pool) });
}

/** Delete a group (?id=). Its Google labels are cleared on the next Sync ads; the Meta set is left in place. */
async function DELETE_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  await pool.query(`DELETE FROM ad_product_groups WHERE id = $1::uuid`, [id]);
  return NextResponse.json({ ok: true, groups: await loadAdGroups(pool) });
}

export const POST = withActivity("shopify/ad-groups", POST_handler);
export const DELETE = withActivity("shopify/ad-groups", DELETE_handler);
