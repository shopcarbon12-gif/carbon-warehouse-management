import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  listShelfMapNavigation,
  listShelfMapSection,
  listUnmappedBins,
} from "@/lib/server/shelf-map";

const AISLE_RE = /^\d{1,3}$/;
const SECTION_RE = /^[A-Z]$/;

/**
 * Shelf Map data for `/overview/locations` Tab 2.
 *
 * Without query params: returns navigation (aisle + section options) and the
 * unmapped-bins list. With `?aisle=&section=`: returns the grid for that
 * section.
 *
 * Both modes scope to the session's active location (`session.lid`).
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const aisle = searchParams.get("aisle")?.trim() ?? "";
  const section = searchParams.get("section")?.trim().toUpperCase() ?? "";

  try {
    if (aisle && section) {
      if (!AISLE_RE.test(aisle) || !SECTION_RE.test(section)) {
        return NextResponse.json({ error: "Invalid aisle or section" }, { status: 400 });
      }
      const bins = await listShelfMapSection(pool, session.lid, aisle, section);
      return NextResponse.json(
        { aisle, section, bins },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const [navigation, unmapped, locRow] = await Promise.all([
      listShelfMapNavigation(pool, session.lid),
      listUnmappedBins(pool, session.lid),
      pool.query<{ id: string; code: string; name: string }>(
        `SELECT id::text, code, name FROM locations
          WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        [session.lid, session.tid],
      ),
    ]);
    const location = locRow.rows[0] ?? null;
    return NextResponse.json(
      { location, navigation, unmapped },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[overview/locations/sections]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
