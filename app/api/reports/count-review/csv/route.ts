import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { reviewCount, type TagRow } from "@/lib/server/count-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTS = ["willGoLive", "liveElsewhere", "newTags", "defective", "killedProducts", "killedNoProduct", "otherStatus", "missing", "manual"] as const;

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET ?ids=a,b&list=missing → that list of the combined count as CSV. */
export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const ids = (sp.get("ids") ?? "").split(",").filter((x) => UUID_RE.test(x));
  const list = sp.get("list") as (typeof LISTS)[number];
  if (!ids.length || !LISTS.includes(list)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const rv = await reviewCount(pool, { tenantId: session.tid, locationId: session.lid, reportIds: ids });
  let lines: string[];
  if (list === "manual") {
    lines = ["custom_sku,product,colour,size,qty", ...rv.manual.map((m) => [m.sku, m.product, m.color, m.size, m.qty].map(cell).join(","))];
  } else {
    let rows = rv[list] as TagRow[];
    if (list === "missing" && rv.missingTotal > rows.length) {
      const all = await pool.query<TagRow & { epc: string }>(
        `SELECT i.epc, i.status, m.description AS product, m.upc, cs.sku, cs.color_code AS color, cs.size, b.code AS bin,
                i.last_seen_at AS "lastSeenAt", l.name AS location, NULL AS file
           FROM items i JOIN locations l ON l.id = i.location_id LEFT JOIN bins b ON b.id = i.bin_id
           LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id LEFT JOIN matrices m ON m.id = cs.matrix_id
          WHERE i.location_id = $1::uuid AND i.status = 'in-stock' AND NOT (i.epc = ANY($2::text[]))
          ORDER BY m.upc NULLS LAST, cs.sku, i.epc`,
        [session.lid, [...rv.scannedSet.keys()]],
      );
      rows = all.rows;
    }
    lines = [
      "epc,status,product,upc,custom_sku,colour,size,bin,last_seen,location,found_in",
      ...rows.map((t) => [t.epc, t.status, t.product, t.upc, t.sku, t.color, t.size, t.bin, t.lastSeenAt, t.location, t.file].map(cell).join(",")),
    ];
  }
  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="count-review-${list}.csv"` },
  });
}
