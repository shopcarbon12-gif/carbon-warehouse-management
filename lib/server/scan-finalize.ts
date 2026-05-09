import type { Pool, PoolClient } from "pg";
import { ingestEpcs, type EpcSource } from "@/lib/server/epc-ingress";
import {
  buildDefectiveCsv,
  epcHexToBits,
  type DefectiveEpcRow,
} from "@/lib/server/upload-defective-epcs";
import {
  markSourceCompleted,
  type ScanSourceType,
} from "@/lib/queries/scan-sources";

/**
 * Shared SAVE/UPLOAD pipeline for both Count and Add-On Count.
 *
 * Phases — matches what the spec calls "Phase 3c shared pipeline":
 *
 *   SAVE intent:
 *     1. Build audit CSV from full rows.
 *     2. Insert inventory_reports row (no defective blob yet).
 *     3. Return reportId. No catalog mutation.
 *
 *   UPLOAD intent:
 *     1–2 same as SAVE.
 *     3. If overrideCatalog (Count screen only — Q21 lock):
 *          tag_kill any existing 'in-stock' items at this location whose
 *          custom_sku is in the scan-row SKU set BUT whose epc isn't in
 *          the scanned set. (Wipe-and-replace.)
 *     4. For each scanned EPC: ingestEpc()
 *          → valid + system_id known  → status 'in-stock' (Q9 lock: creates new row)
 *          → invalid OR unknown       → status 'tag_killed' + collected for defective CSV
 *     5. Build defective CSV (Q30 column set), UPDATE the report row to
 *        attach it.
 *     6. If addOnSourceId provided, mark that source row completed (Q29 lock:
 *        events table preserves history; super-admin can re-open later).
 *
 * The whole UPLOAD path runs inside a single transaction. If anything
 * mid-pipeline throws, the whole thing rolls back — there is no partial
 * "audit row exists but catalog half-mutated" state.
 */

export type ScanFinalizeRow = {
  epc?: string | null;
  system_id?: string | number | null;
  custom_sku?: string | null;
  item_name?: string | null;
  color?: string | null;
  size?: string | null;
  retail_price?: string | number | null;
  bin?: string | null;
  seen_count?: string | number | null;
  first_seen_iso?: string | null;
  last_seen_iso?: string | null;
};

export type ScanFinalizeIntent = "save" | "upload";

export type ScanFinalizeScreen =
  | "count_inventory"
  | "count_inventory_override"
  | "add_on_count";

export type ScanFinalizeInput = {
  tenantId: string;
  locationId: string;
  userId: string | null;
  deviceId: string | null;
  intent: ScanFinalizeIntent;
  /** Which screen produced this — also used as items.source on UPLOAD. */
  screen: ScanFinalizeScreen;
  /** Q21 lock: override-replace wipes to tag_killed. Count-screen only. */
  overrideCatalog?: boolean;
  rows: ScanFinalizeRow[];
  /** When screen='add_on_count', the source they walked against. */
  addOnSourceType?: ScanSourceType;
  addOnSourceId?: string;
  /** When screen='add_on_count', the session that produced this. */
  addOnSessionId?: string;
  /** Operator-visible filename suggested by the mobile client, e.g.
   *  `count-0508-851-Elior.csv`. When provided, this is what gets stamped
   *  onto inventory_reports.filename so the web reports page shows the
   *  same name the operator saw on the handheld at commit time.
   *  Falls back to the legacy auto-generated name when null/empty.
   *  Defective filenames (the secondary attachment) are not affected —
   *  they keep the `<filename>.defective.csv` suffix derived from this. */
  clientFilename?: string;
};

export type ScanFinalizeResult = {
  reportId: string;
  rowsArchived: number;
  rowsValid: number;
  rowsFailed: number;
  wipedCount: number;
  defectiveRowCount: number;
};

const AUDIT_HEADER =
  "epc,system_id,custom_sku,item_name,color,size,retail_price,bin,seen_count,first_seen_iso,last_seen_iso";

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildAuditCsv(rows: ScanFinalizeRow[]): string {
  const lines = [AUDIT_HEADER];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.epc),
        csvCell(r.system_id),
        csvCell(r.custom_sku),
        csvCell(r.item_name),
        csvCell(r.color),
        csvCell(r.size),
        csvCell(r.retail_price),
        csvCell(r.bin),
        csvCell(r.seen_count),
        csvCell(r.first_seen_iso),
        csvCell(r.last_seen_iso),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function buildFilename(screen: ScanFinalizeScreen, when: Date): string {
  const a = screen.toUpperCase();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const y = when.getUTCFullYear();
  const mo = pad(when.getUTCMonth() + 1);
  const d = pad(when.getUTCDate());
  const h = pad(when.getUTCHours());
  const mi = pad(when.getUTCMinutes());
  const s = pad(when.getUTCSeconds());
  return `${a}_${y}${mo}${d}_${h}${mi}${s}.csv`;
}

function activityForScreen(screen: ScanFinalizeScreen): string {
  // Human-readable activity values stored in inventory_reports.activity.
  // These are also what the source-picker matches against — see
  // lib/queries/scan-sources.ts.
  switch (screen) {
    case "count_inventory":
      return "MOBILE COUNT";
    case "count_inventory_override":
      return "MOBILE COUNT (OVERRIDE)";
    case "add_on_count":
      return "ADD-ON COUNT";
  }
}

function sourceForScreen(screen: ScanFinalizeScreen): EpcSource {
  switch (screen) {
    case "count_inventory":
      return "count_inventory";
    case "count_inventory_override":
      return "count_inventory_override";
    case "add_on_count":
      return "add_on_count";
  }
}

/** Wipe existing live items for the SKUs covered by `scannedSkus` whose EPC
 *  isn't in `keepEpcs`. Returns count of rows wiped. */
async function wipeOverrideReplace(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  scannedSkus: string[],
  keepEpcs: string[],
): Promise<number> {
  if (scannedSkus.length === 0) return 0;

  const r = await client.query(
    `UPDATE items i
        SET status = 'tag_killed',
            last_seen_at = now()
       FROM custom_skus cs, locations l
      WHERE i.custom_sku_id = cs.id
        AND i.location_id = l.id
        AND l.tenant_id = $1::uuid
        AND i.location_id = $2::uuid
        AND i.status = 'in-stock'
        AND cs.sku = ANY($3::text[])
        AND NOT (i.epc = ANY($4::text[]))`,
    [tenantId, locationId, scannedSkus, keepEpcs],
  );
  return r.rowCount ?? 0;
}

export async function finalizeScanSession(
  pool: Pool,
  input: ScanFinalizeInput,
): Promise<ScanFinalizeResult> {
  const now = new Date();
  const csv = buildAuditCsv(input.rows);
  // Honour client-supplied filename (operator-visible name from mobile)
  // when provided; otherwise fall back to the screen+timestamp name.
  // Strip any path separators / control chars defensively — this string
  // ends up in inventory_reports.filename and may be rendered as-is.
  const sanitizedClientName = (input.clientFilename ?? "")
    .replace(/[\\/\r\n\t]+/g, "")
    .trim()
    .slice(0, 200);
  const filename = sanitizedClientName.length > 0
    ? sanitizedClientName
    : buildFilename(input.screen, now);
  const activity = activityForScreen(input.screen);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* ---- 1. Insert audit row in inventory_reports ---- */
    const reportR = await client.query<{ id: string }>(
      `INSERT INTO inventory_reports
         (tenant_id, activity, uploaded_at, uploaded_by, device_id,
          override_catalog, row_count, csv_content, filename, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9,
               ($3::timestamptz + interval '1 year'))
       RETURNING id::text`,
      [
        input.tenantId,
        activity,
        now,
        input.userId,
        input.deviceId,
        !!input.overrideCatalog,
        input.rows.length,
        csv,
        filename,
      ],
    );
    const reportId = reportR.rows[0]!.id;

    /* ---- 2. SAVE = stop here. No catalog mutation. ---- */
    if (input.intent === "save") {
      await client.query("COMMIT");
      return {
        reportId,
        rowsArchived: input.rows.length,
        rowsValid: 0,
        rowsFailed: 0,
        wipedCount: 0,
        defectiveRowCount: 0,
      };
    }

    /* ---- 3. UPLOAD: optional override-replace wipe (Count screen only) ---- */
    let wipedCount = 0;
    const epcsScanned = input.rows
      .map((r) => r.epc?.replace(/\s/g, "").toUpperCase())
      .filter((e): e is string => !!e && /^[0-9A-F]{24}$/.test(e));

    if (input.overrideCatalog && input.screen !== "add_on_count") {
      const scannedSkus = Array.from(
        new Set(
          input.rows
            .map((r) => r.custom_sku?.toString().trim())
            .filter((s): s is string => !!s),
        ),
      );
      wipedCount = await wipeOverrideReplace(
        client,
        input.tenantId,
        input.locationId,
        scannedSkus,
        epcsScanned,
      );
    }

    /* ---- 4. Per-EPC ingest. Decode → custom_sku lookup → in-stock or tag_killed. ---- */
    const epcSource = sourceForScreen(input.screen);
    const ingressInputs = epcsScanned.map((epc) => ({
      tenantId: input.tenantId,
      epc,
      source: epcSource,
      sourceDeviceLabel: input.deviceId,
      locationId: input.locationId,
      receivedAt: now,
    }));

    const ingressResults = await ingestEpcs(client, ingressInputs);

    let rowsValid = 0;
    const failures: DefectiveEpcRow[] = [];
    for (let i = 0; i < ingressResults.length; i++) {
      const result = ingressResults[i]!;
      const epc = epcsScanned[i]!;
      if (result.status === "in-stock") {
        rowsValid++;
      } else {
        failures.push({
          epc,
          scannedAtIso: now.toISOString(),
          decodeReason: result.reason ?? "invalid",
          rawDecodedBits: epcHexToBits(epc),
          deviceId: input.deviceId,
          operatorUserId: input.userId,
        });
      }
    }

    /* ---- 5. Attach defective CSV to the report row. ---- */
    const defectiveCsv = buildDefectiveCsv(failures);
    if (failures.length > 0) {
      await client.query(
        `UPDATE inventory_reports
            SET defective_csv_blob = $1,
                defective_row_count = $2
          WHERE id = $3::uuid AND tenant_id = $4::uuid`,
        [defectiveCsv, failures.length, reportId, input.tenantId],
      );
    }

    /* ---- 6. Mark Add-On source completed + link session → report ---- */
    if (input.screen === "add_on_count" && input.addOnSourceId && input.addOnSourceType) {
      await markSourceCompleted(
        pool,
        input.tenantId,
        input.addOnSourceType,
        input.addOnSourceId,
        input.userId,
      );
    }
    if (input.addOnSessionId) {
      await client.query(
        `UPDATE add_on_sessions
            SET state = 'completed',
                ended_at = now(),
                report_id = $1::uuid
          WHERE id = $2::uuid AND tenant_id = $3::uuid`,
        [reportId, input.addOnSessionId, input.tenantId],
      );
    }

    await client.query("COMMIT");
    return {
      reportId,
      rowsArchived: input.rows.length,
      rowsValid,
      rowsFailed: failures.length,
      wipedCount,
      defectiveRowCount: failures.length,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow — original error wins */
    }
    throw e;
  } finally {
    client.release();
  }
}
