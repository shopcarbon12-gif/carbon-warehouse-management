import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { decodeSGTIN96 } from "@/lib/utils/epc";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";

/**
 * Look up what we know about a scanned EPC. Used by the handheld Encode
 * screen during the brief "read" half of the trigger pull, before the
 * write half. The caller hands us the EPC the chip currently advertises;
 * we tell them whether it's a Carbon-Jeans tag, what SKU/state it points
 * to, and whether to treat it as a known item or a fresh / foreign tag.
 *
 * Auth: any authenticated session (cookie or Bearer).
 *
 * Body:  { epc: 24-hex }
 * 200:
 *   {
 *     ok: true,
 *     status: "known" | "valid_orphan" | "foreign",
 *     epc: 24-hex,
 *     decoded?: { prefix: number, system_id: number, serial: number },
 *     item?: {
 *       id: string, status: string, custom_sku_id: string,
 *       sku: string, name: string, color: string, size: string,
 *       bin_code: string | null, last_seen_at: string | null,
 *     }
 *   }
 *
 * Status meaning:
 *   • "known"        — EPC passes formula AND items row exists at this location
 *   • "valid_orphan" — EPC passes formula but no items row (rare; Senitron
 *                      printed it, WMS hasn't ingested yet)
 *   • "foreign"      — EPC doesn't carry our company prefix
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  epc: z.string().regex(/^[0-9A-Fa-f]{24}$/u, "epc must be 24 hex chars"),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const epc = parsed.data.epc.toUpperCase();

  // Decode the bits using the project's standard SGTIN-96 packing
  // (prefix 20 | asset 40 | serial 36). Returns null only if the hex
  // doesn't parse — already guarded by zod regex, but kept for clarity.
  const decoded = decodeSGTIN96(epc);
  if (!decoded) {
    return NextResponse.json(
      { ok: true, status: "foreign", epc },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const carbonPrefix = envCompanyPrefix();
  const isOurs = decoded.companyPrefix === carbonPrefix;

  if (!isOurs) {
    return NextResponse.json(
      {
        ok: true,
        status: "foreign",
        epc,
        decoded: {
          prefix: decoded.companyPrefix,
          system_id: decoded.itemReference,
          serial: decoded.serialNumber,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json(
      { error: "Database unavailable" },
      { status: 503 },
    );
  }

  // Items row + custom_sku descriptors + bin code in one query so the
  // handheld can render a complete "this tag currently is …" panel
  // without a second round trip.
  const r = await pool.query<{
    id: string;
    status: string;
    custom_sku_id: string;
    sku: string | null;
    name: string | null;
    color: string | null;
    size: string | null;
    bin_code: string | null;
    last_seen_at: string | null;
  }>(
    // custom_skus has no `name`, `color`, or other display columns —
    // those live on matrices (matrix-level name) + cs.color_code +
    // cs.size. Older revisions of this route referenced cs.name and
    // cs.color directly; that's been broken under PG since the
    // column rename and was surfacing as "Server error" on every
    // encode-resolve call (visible in the workspace's enrichEpc fail).
    `SELECT
       i.id::text                               AS id,
       i.status                                 AS status,
       i.custom_sku_id::text                    AS custom_sku_id,
       cs.sku                                   AS sku,
       m.description                            AS name,
       cs.color_code                            AS color,
       cs.size                                  AS size,
       b.code                                   AS bin_code,
       i.last_seen_at::text                     AS last_seen_at
     FROM items i
     LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices    m  ON m.id = cs.matrix_id
     LEFT JOIN bins        b  ON b.id = i.bin_id
     WHERE i.epc = $1 AND i.location_id = $2::uuid
     LIMIT 1`,
    [epc, session.lid],
  );
  const row = r.rows[0];

  if (!row) {
    return NextResponse.json(
      {
        ok: true,
        status: "valid_orphan",
        epc,
        decoded: {
          prefix: decoded.companyPrefix,
          system_id: decoded.itemReference,
          serial: decoded.serialNumber,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      status: "known",
      epc,
      decoded: {
        prefix: decoded.companyPrefix,
        system_id: decoded.itemReference,
        serial: decoded.serialNumber,
      },
      item: {
        id: row.id,
        status: row.status,
        custom_sku_id: row.custom_sku_id,
        sku: row.sku ?? "",
        name: row.name ?? "",
        color: row.color ?? "",
        size: row.size ?? "",
        bin_code: row.bin_code,
        last_seen_at: row.last_seen_at,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
