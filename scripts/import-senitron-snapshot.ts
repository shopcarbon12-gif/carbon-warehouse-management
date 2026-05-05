/**
 * One-shot importer that backfills `items` from a Senitron inventory export.
 *
 * Why: pre-handheld-encode rollout, the WMS `items` table only knows about
 * tags commissioned through the WMS web flow. Tags Senitron printed and
 * pushed to its own cloud aren't in the WMS DB — yet they exist on real
 * garments and the same fixed readers see them. This script ingests the
 * Senitron snapshot so:
 *
 *   1. Every existing tag is a row in `items` with the exact serial that
 *      Senitron issued. The EPC's bottom 36 bits and `items.serial_number`
 *      are guaranteed equal afterwards.
 *   2. The new handheld Encode flow (POST /api/rfid/encode-claim) computes
 *      `MAX(serial)+1` against a now-complete history, so freshly-encoded
 *      tags can never collide with a Senitron-issued one.
 *
 * CSV path defaults to `scripts/data/senitron-snapshot.csv` (committed
 * alongside this file). Override with `SENITRON_CSV=/path/to.csv`.
 *
 * Usage:
 *   DATABASE_URL=postgres://… npx tsx scripts/import-senitron-snapshot.ts [--apply]
 *
 * Without --apply, runs in dry-run mode: reports how many rows would be
 * inserted/updated without touching the DB. --apply commits the changes.
 *
 * Notes:
 *   • EPC uniqueness lives in `items_epc_unique`. Imports use `ON CONFLICT
 *     (epc) DO UPDATE` so re-running is idempotent.
 *   • Senitron `Asset ID` column = `custom_skus.ls_system_id`. Rows whose
 *     ls_system_id has no matching `custom_skus` row in this tenant are
 *     skipped and logged — they're SKUs Senitron knows but Lightspeed→WMS
 *     hasn't synced into the catalog yet. Run the LS catalog sync first.
 *   • Status mapping: every Senitron row in the export is "Live" → WMS
 *     `in-stock`. Other Senitron statuses are not in the current export
 *     but the helper translates them defensively.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

type CsvRow = Record<string, string>;

const APPLY = process.argv.includes("--apply");
const CSV_PATH =
  process.env.SENITRON_CSV ??
  path.join(process.cwd(), "scripts/data/senitron-snapshot.csv");

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  console.log(`mode      : ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
  console.log(`csv       : ${CSV_PATH}`);
  console.log(`db        : ${dbUrl.replace(/:[^:@]+@/u, ":****@")}`);

  const raw = await fs.readFile(CSV_PATH, "utf8");
  const rows = parseCsv(raw);
  console.log(`rows read : ${rows.length.toLocaleString()}`);

  // Derive the unique set of (epc, asset_id, serial, status) we're about
  // to push. Skip rows missing EPC or Asset ID.
  type Snapshot = {
    epc: string;
    lsSystemId: string;
    serial: number;
    status: string;
  };
  const snap: Snapshot[] = [];
  let skipped = 0;
  for (const r of rows) {
    const epc = (r["EpcId"] || "").trim().toUpperCase();
    const ls = (r["Asset ID"] || "").trim();
    const serRaw = (r["Serial#"] || "").trim();
    if (!/^[0-9A-F]{24}$/u.test(epc) || !/^[0-9]+$/u.test(ls)) {
      skipped += 1;
      continue;
    }
    const serial = Number.parseInt(serRaw, 10);
    if (!Number.isFinite(serial)) {
      skipped += 1;
      continue;
    }
    snap.push({
      epc,
      lsSystemId: ls,
      serial,
      status: mapStatus(r["Status"]),
    });
  }
  console.log(`valid rows: ${snap.length.toLocaleString()}  (skipped ${skipped})`);

  const pool = new Pool({ connectionString: dbUrl });
  try {
    // Tenant + location resolution — the import is location-scoped to
    // Orlando Warehouse. Caller can override with SENITRON_LOCATION_CODE.
    const locCode = process.env.SENITRON_LOCATION_CODE ?? "ORLANDO";
    const loc = await pool.query<{ id: string; tenant_id: string; name: string }>(
      `SELECT id::text, tenant_id::text, name
         FROM locations
         WHERE upper(code) = upper($1)
         ORDER BY created_at ASC
         LIMIT 1`,
      [locCode],
    );
    if (!loc.rows[0]) {
      console.error(`location code "${locCode}" not found`);
      process.exit(1);
    }
    const { id: locationId, tenant_id: tenantId, name: locName } = loc.rows[0];
    console.log(`location  : ${locName}  (${locationId})`);
    console.log(`tenant    : ${tenantId}`);

    // Resolve every distinct ls_system_id to a custom_skus.id once. SKUs
    // missing from the catalog are dropped from the import — this lets
    // the operator know they need to run a Lightspeed catalog sync first.
    const distinctLs = Array.from(new Set(snap.map((s) => s.lsSystemId)));
    const skuRows = await pool.query<{ id: string; ls_system_id: string }>(
      `SELECT id::text, ls_system_id::text
         FROM custom_skus
         WHERE tenant_id = $1::uuid
           AND ls_system_id::text = ANY($2::text[])`,
      [tenantId, distinctLs],
    );
    const skuByLs = new Map(skuRows.rows.map((r) => [r.ls_system_id, r.id]));
    const missingSkus = distinctLs.filter((ls) => !skuByLs.has(ls));
    console.log(
      `sku match : ${skuByLs.size.toLocaleString()} / ${distinctLs.length.toLocaleString()} ls_system_ids matched`,
    );
    if (missingSkus.length > 0) {
      console.log(
        `missing   : ${missingSkus.length} ls_system_id(s) not in custom_skus — first 5: ${missingSkus.slice(0, 5).join(", ")}`,
      );
    }

    const importable = snap.filter((s) => skuByLs.has(s.lsSystemId));
    console.log(`importable: ${importable.length.toLocaleString()} rows`);

    if (!APPLY) {
      console.log("\n[dry-run] no DB writes performed. re-run with --apply.");
      return;
    }

    // Batch upsert. INSERT … ON CONFLICT (epc) so re-runs are idempotent.
    // Bulk insert via UNNEST keeps roundtrips low even for ~24k rows.
    const epcs = importable.map((r) => r.epc);
    const serials = importable.map((r) => r.serial);
    const skuIds = importable.map((r) => skuByLs.get(r.lsSystemId)!);
    const statuses = importable.map((r) => r.status);

    const t0 = Date.now();
    const res = await pool.query<{ inserted: string; updated: string }>(
      `WITH src AS (
         SELECT
           UNNEST($1::text[])      AS epc,
           UNNEST($2::bigint[])    AS serial_number,
           UNNEST($3::uuid[])      AS custom_sku_id,
           UNNEST($4::text[])      AS status
       ),
       upsert AS (
         INSERT INTO items (epc, serial_number, custom_sku_id, location_id, status)
         SELECT epc, serial_number, custom_sku_id, $5::uuid, status FROM src
         ON CONFLICT (epc) DO UPDATE SET
           serial_number = EXCLUDED.serial_number,
           custom_sku_id = EXCLUDED.custom_sku_id,
           status        = CASE
             WHEN items.status IN ('sold', 'tag_killed') THEN items.status
             ELSE EXCLUDED.status
           END
         RETURNING (xmax = 0) AS was_inserted
       )
       SELECT
         count(*) FILTER (WHERE was_inserted)::text  AS inserted,
         count(*) FILTER (WHERE NOT was_inserted)::text AS updated
       FROM upsert`,
      [epcs, serials, skuIds, statuses, locationId],
    );
    const ms = Date.now() - t0;
    const { inserted, updated } = res.rows[0] ?? { inserted: "0", updated: "0" };
    console.log(`\n=== APPLIED in ${ms} ms ===`);
    console.log(`inserted  : ${Number(inserted).toLocaleString()}`);
    console.log(`updated   : ${Number(updated).toLocaleString()}`);
  } finally {
    await pool.end();
  }
}

/** Senitron Status → WMS items.status. The current export is 100% Live. */
function mapStatus(senitron: string | undefined): string {
  const s = (senitron ?? "").trim().toLowerCase();
  switch (s) {
    case "live":
    case "":
      return "in-stock";
    case "sold":
      return "sold";
    case "stolen":
    case "tag killed":
    case "tag_killed":
      return "tag_killed";
    case "in-transit":
    case "in transit":
      return "in-transit";
    default:
      return "in-stock";
  }
}

/** Minimal CSV parser that handles quoted fields with embedded commas. */
function parseCsv(text: string): CsvRow[] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      cur.push(field);
      field = "";
      lines.push(cur);
      cur = [];
      continue;
    }
    field += c;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    lines.push(cur);
  }
  if (lines.length === 0) return [];
  const header = lines[0]!;
  const out: CsvRow[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const row = lines[r]!;
    if (row.length === 1 && row[0] === "") continue;
    const obj: CsvRow = {};
    for (let c = 0; c < header.length; c += 1) {
      obj[header[c] ?? ""] = row[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
