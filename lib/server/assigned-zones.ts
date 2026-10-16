import type { Pool, PoolClient } from "pg";
import type { SessionPayload } from "@/lib/auth";
import { isSuperAdminRole } from "@/lib/auth/roles";
import { getMembershipRole } from "@/lib/queries/membership-role";
import { decodeEpc } from "@/lib/server/epc-decode";
import { loadEpcConfig } from "@/lib/server/epc-ingress";
import { legacyEpcSystemId } from "@/lib/server/legacy-epc-catalog";
import { loadRetiredEpcs } from "@/lib/server/retired-epcs";
import { isIssuableSerial } from "@/lib/server/rfid-serial-allocator";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";
import type { BinActor } from "@/lib/server/bin-engine";
import { shortName } from "@/lib/format-name";

/**
 * Zone Management (owner, 2026-10-16). A zone ("Store", …) is assigned to
 * specific tags by a person scanning them — per EPC — and never touches the
 * tag's bins. One zone per tag; it clears by itself when the tag is sold,
 * moves to another location or stops being LIVE (trigger, migration 0120).
 * Only LIVE tags of the current location can be assigned; every other tag
 * read in the same scan comes back with a reason and its full details.
 *
 * Separate from the reader zones in `zones` (where a fixed reader last heard
 * the tag) — fixed readers never change an assigned zone.
 */

export type ZoneSkipReason =
  | "not_live"
  | "other_location"
  | "not_in_wms"
  | "not_carbon"
  | "damaged_chip"
  | "retired";

export type ZoneTagDetails = {
  epc: string;
  serial: string | null;
  product: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  retailPrice: string | null;
  status: string | null;
  statusLabel: string | null;
  bin: string | null;
  extraBins: string[];
  location: string | null;
  zone: string | null;
  zoneId: string | null;
  zoneAssignedAt: string | null;
  lastSeenAt: string | null;
  lastSeenReaderZone: string | null;
  firstSeenAt: string | null;
  source: string | null;
};

export type ZoneCheckRow = {
  epc: string;
  ok: boolean;
  reason: ZoneSkipReason | null;
  reasonText: string | null;
  details: ZoneTagDetails;
};

export type ZoneRow = { id: string; name: string; count: number; createdAt: string };

const normEpc = (e: string) => e.replace(/\s/g, "").toUpperCase();

/**
 * Same rule as bins: desktop admin / manager / member, or the handheld
 * role's Zone Management screen ("manage" = create / rename / delete zones).
 */
export async function canChangeZones(
  pool: Pool,
  session: SessionPayload,
  what: "assign" | "manage",
): Promise<boolean> {
  const role = ((await getMembershipRole(pool, session.sub, session.tid)) ?? "member").trim().toLowerCase();
  if (role === "admin" || role === "manager" || role === "member") return true;
  const r = await pool.query<{ mobile_role_id: number | null; role_name: string | null; permissions: unknown }>(
    `SELECT u.mobile_role_id, mr.name AS role_name, mr.permissions
       FROM users u
       LEFT JOIN user_roles mr ON mr.id = u.mobile_role_id AND mr.scope = 'mobile'
      WHERE u.id = $1::uuid
      LIMIT 1`,
    [session.sub],
  );
  const row = r.rows[0];
  if (!row || row.mobile_role_id == null) return true;
  if (isSuperAdminRole(role) || (row.role_name ?? "").trim().toLowerCase() === "super admin") return true;
  const perm = (row.permissions && typeof row.permissions === "object"
    ? (row.permissions as Record<string, Record<string, string>>)
    : {})["bin"] ?? {};
  const hidden = (id: string) => perm[id] === "hide";
  const editable = !hidden("zone_management") && !hidden("zone_management__edit");
  return what === "assign" ? editable : editable && !hidden("zone_management__manage_zones");
}

export async function listZones(pool: Pool, tenantId: string, locationId: string): Promise<ZoneRow[]> {
  const r = await pool.query<{ id: string; name: string; count: number; created_at: Date }>(
    `SELECT z.id::text, z.name, z.created_at,
            (SELECT count(*)::int FROM items i
              WHERE i.assigned_zone_id = z.id AND i.status = 'in-stock') AS count
       FROM assigned_zones z
      WHERE z.tenant_id = $1::uuid AND z.location_id = $2::uuid AND z.archived_at IS NULL
      ORDER BY lower(z.name)`,
    [tenantId, locationId],
  );
  return r.rows.map((z) => ({ id: z.id, name: z.name, count: z.count, createdAt: z.created_at.toISOString() }));
}

async function zoneAt(client: Pool | PoolClient, tenantId: string, locationId: string, zoneId: string) {
  const r = await client.query<{ id: string; name: string }>(
    `SELECT id::text, name FROM assigned_zones
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND location_id = $3::uuid AND archived_at IS NULL`,
    [zoneId, tenantId, locationId],
  );
  return r.rows[0] ?? null;
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, 60);

export async function createZone(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  name: string,
  userId: string | null,
): Promise<{ id: string; name: string }> {
  const n = cleanName(name);
  if (!n) throw new Error("BAD_REQUEST:Zone name is required");
  const dup = await client.query(
    `SELECT 1 FROM assigned_zones
      WHERE location_id = $1::uuid AND archived_at IS NULL AND lower(name) = lower($2) LIMIT 1`,
    [locationId, n],
  );
  if (dup.rows[0]) throw new Error(`BAD_REQUEST:Zone "${n}" already exists`);
  const r = await client.query<{ id: string }>(
    `INSERT INTO assigned_zones (tenant_id, location_id, name, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid) RETURNING id::text`,
    [tenantId, locationId, n, userId],
  );
  return { id: r.rows[0]!.id, name: n };
}

export async function renameZone(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  zoneId: string,
  name: string,
): Promise<{ name: string }> {
  const n = cleanName(name);
  if (!n) throw new Error("BAD_REQUEST:Zone name is required");
  if (!(await zoneAt(client, tenantId, locationId, zoneId))) throw new Error("BAD_REQUEST:Zone not found");
  const dup = await client.query(
    `SELECT 1 FROM assigned_zones
      WHERE location_id = $1::uuid AND archived_at IS NULL AND lower(name) = lower($2) AND id <> $3::uuid LIMIT 1`,
    [locationId, n, zoneId],
  );
  if (dup.rows[0]) throw new Error(`BAD_REQUEST:Zone "${n}" already exists`);
  await client.query(`UPDATE assigned_zones SET name = $2 WHERE id = $1::uuid`, [zoneId, n]);
  return { name: n };
}

/** Deletes a zone: its tags lose it (history per tag), the zone is archived. */
export async function deleteZone(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  zoneId: string,
  actor: BinActor,
): Promise<{ cleared: number }> {
  const z = await zoneAt(client, tenantId, locationId, zoneId);
  if (!z) throw new Error("BAD_REQUEST:Zone not found");
  const cleared = await client.query<{ epc: string }>(
    `UPDATE items SET assigned_zone_id = NULL, zone_assigned_at = NULL, zone_assigned_by = NULL
      WHERE assigned_zone_id = $1::uuid
      RETURNING epc`,
    [zoneId],
  );
  await auditZone(client, tenantId, cleared.rows.map((r) => ({ epc: r.epc, old: z.name, new: null, reason: "zone_deleted" })), actor);
  await client.query(`UPDATE assigned_zones SET archived_at = now() WHERE id = $1::uuid`, [zoneId]);
  return { cleared: cleared.rowCount ?? 0 };
}

async function auditZone(
  client: PoolClient,
  tenantId: string,
  rows: { epc: string; old: string | null; new: string | null; reason: string }[],
  actor: BinActor,
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO inventory_audit_logs
       (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
     SELECT $1::uuid, 'ADJUSTMENT', 'EPC', r.epc, r.old, r.new, r.reason, NULL, $3::uuid, $4
       FROM jsonb_to_recordset($2::jsonb) AS r(epc text, old text, new text, reason text)`,
    [tenantId, JSON.stringify(rows), actor.userId, actor.deviceId],
  );
}

type DetailRow = {
  epc: string;
  serial_number: string | null;
  status: string;
  location_id: string;
  location: string | null;
  product: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  retail_price: string | null;
  bin: string | null;
  extra_bins: string[] | null;
  zone_id: string | null;
  zone: string | null;
  zone_assigned_at: Date | null;
  last_seen_at: Date | null;
  reader_zone: string | null;
  first_scanned_at: Date | null;
  source: string | null;
};

const DETAIL_SELECT = `
  SELECT i.epc, i.serial_number::text AS serial_number, i.status, i.location_id::text AS location_id,
         l.name AS location, m.description AS product, cs.sku, cs.color_code AS color, cs.size,
         cs.retail_price::text AS retail_price,
         b.code AS bin,
         ARRAY(SELECT xb.code FROM unnest(i.additional_bin_ids) AS x(id)
                 JOIN bins xb ON xb.id = x.id AND xb.archived_at IS NULL
                WHERE x.id IS DISTINCT FROM i.bin_id ORDER BY xb.code) AS extra_bins,
         az.id::text AS zone_id, az.name AS zone, i.zone_assigned_at,
         i.last_seen_at, rz.name AS reader_zone, i.first_scanned_at,
         COALESCE(sd.name, i.source_device_label, i.source) AS source
    FROM items i
    JOIN locations l ON l.id = i.location_id
    LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
    LEFT JOIN matrices m ON m.id = cs.matrix_id
    LEFT JOIN bins b ON b.id = i.bin_id AND b.archived_at IS NULL
    LEFT JOIN assigned_zones az ON az.id = i.assigned_zone_id
    LEFT JOIN zones rz ON rz.id = i.last_seen_zone_id
    LEFT JOIN devices sd ON sd.id = i.source_device_id`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toDetails(r: DetailRow): ZoneTagDetails {
  return {
    epc: r.epc,
    serial: r.serial_number,
    product: r.product,
    sku: r.sku,
    color: r.color,
    size: r.size,
    retailPrice: r.retail_price,
    status: r.status,
    statusLabel: labelNameForWmsStatus(r.status),
    bin: r.bin,
    extraBins: r.extra_bins ?? [],
    location: r.location,
    zone: r.zone,
    zoneId: r.zone_id,
    zoneAssignedAt: iso(r.zone_assigned_at),
    lastSeenAt: iso(r.last_seen_at),
    lastSeenReaderZone: r.reader_zone,
    firstSeenAt: iso(r.first_scanned_at),
    source: r.source,
  };
}

const emptyDetails = (epc: string): ZoneTagDetails => ({
  epc,
  serial: null,
  product: null,
  sku: null,
  color: null,
  size: null,
  retailPrice: null,
  status: null,
  statusLabel: null,
  bin: null,
  extraBins: [],
  location: null,
  zone: null,
  zoneId: null,
  zoneAssignedAt: null,
  lastSeenAt: null,
  lastSeenReaderZone: null,
  firstSeenAt: null,
  source: null,
});

/**
 * Checks every scanned EPC: LIVE at this location → ok; anything else → the
 * reason and every detail the WMS knows about the tag (or, for a number the
 * WMS has no record of, what the number itself decodes to).
 */
export async function checkEpcsForZone(
  pool: Pool,
  tenantId: string,
  locationId: string,
  rawEpcs: string[],
): Promise<ZoneCheckRow[]> {
  const epcs = [...new Set(rawEpcs.map(normEpc).filter(Boolean))];
  if (epcs.length === 0) return [];
  const r = await pool.query<DetailRow>(
    `${DETAIL_SELECT}
      WHERE l.tenant_id = $1::uuid AND i.epc = ANY($2::text[])`,
    [tenantId, epcs],
  );
  const byEpc = new Map(r.rows.map((row) => [row.epc.toUpperCase(), row]));
  const missing = epcs.filter((e) => !byEpc.has(e));
  const retired = missing.length ? await loadRetiredEpcs(pool, missing) : new Set<string>();

  // What a number the WMS has no record of decodes to.
  const decoded = new Map<string, { valid: boolean; reason: string | null; systemId: string | null; serial: string | null }>();
  if (missing.length) {
    const client = await pool.connect();
    try {
      const cfg = await loadEpcConfig(client, tenantId);
      for (const e of missing) {
        const d = cfg ? decodeEpc(e, cfg) : null;
        let systemId = d?.valid && d.systemId !== null ? d.systemId.toString() : null;
        if (!systemId) systemId = legacyEpcSystemId(e)?.toString() ?? null;
        decoded.set(e, {
          valid: !!d?.valid,
          reason: d?.valid ? null : (d?.reason ?? "bad_config"),
          systemId,
          serial: d?.serial != null ? d.serial.toString() : null,
        });
      }
    } finally {
      client.release();
    }
  }
  const sids = [...new Set([...decoded.values()].map((d) => d.systemId).filter((x): x is string => !!x))];
  const cat = new Map<string, { product: string | null; sku: string; color: string | null; size: string | null; retail_price: string | null }>();
  if (sids.length) {
    const c = await pool.query<{ sid: string; product: string | null; sku: string; color: string | null; size: string | null; retail_price: string | null }>(
      `SELECT cs.ls_system_id::text AS sid, m.description AS product, cs.sku, cs.color_code AS color, cs.size,
              cs.retail_price::text AS retail_price
         FROM custom_skus cs LEFT JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.ls_system_id::text = ANY($1::text[])`,
      [sids],
    );
    for (const row of c.rows) cat.set(row.sid, row);
  }

  return epcs.map((epc): ZoneCheckRow => {
    const row = byEpc.get(epc);
    if (row) {
      const details = toDetails(row);
      if (row.location_id !== locationId) {
        return { epc, ok: false, reason: "other_location", reasonText: `Belongs to another location (${row.location ?? "—"})`, details };
      }
      if (row.status !== "in-stock") {
        return { epc, ok: false, reason: "not_live", reasonText: `Not LIVE — status ${labelNameForWmsStatus(row.status)}`, details };
      }
      return { epc, ok: true, reason: null, reasonText: null, details };
    }
    const d = decoded.get(epc)!;
    const c = d.systemId ? cat.get(d.systemId) : undefined;
    const details: ZoneTagDetails = {
      ...emptyDetails(epc),
      serial: d.serial,
      product: c?.product ?? null,
      sku: c?.sku ?? null,
      color: c?.color ?? null,
      size: c?.size ?? null,
      retailPrice: c?.retail_price ?? null,
    };
    if (retired.has(epc)) {
      return { epc, ok: false, reason: "retired", reasonText: "Old number of a re-encoded tag — the garment carries a new tag now", details };
    }
    if (!d.valid && !c) {
      return { epc, ok: false, reason: "not_carbon", reasonText: `Not a Carbon tag number (${d.reason ?? "does not decode"})`, details };
    }
    if (d.serial !== null && !isIssuableSerial(BigInt(d.serial))) {
      return { epc, ok: false, reason: "damaged_chip", reasonText: `Damaged-chip read — serial ${d.serial} was never issued`, details };
    }
    return {
      epc,
      ok: false,
      reason: "not_in_wms",
      reasonText: c ? "Not in the WMS — this tag number was never added (product decoded from the number)" : "Not in the WMS — unknown product",
      details,
    };
  });
}

/** One line of a zone report — every tag of the scan and what happened to it. */
export type ZoneReportLine = {
  epc: string;
  result: "assigned" | "moved" | "already in zone" | "removed" | "not in this zone" | "skipped";
  reason: string | null;
  details: ZoneTagDetails;
  zoneAfter: string | null;
};

/**
 * Assigns the LIVE tags of this location among `epcs` to the zone (moving
 * them from another zone if they had one). `epcs` is the whole scan: tags
 * that can't be assigned come back as skipped lines with the reason and all
 * their details, so the zone report keeps them. Must run inside a transaction.
 */
export async function assignEpcsToZone(
  pool: Pool,
  client: PoolClient,
  tenantId: string,
  locationId: string,
  zoneId: string,
  epcs: string[],
  actor: BinActor,
): Promise<{
  assigned: number;
  moved: number;
  alreadyInZone: number;
  skipped: ZoneCheckRow[];
  zone: string;
  lines: ZoneReportLine[];
}> {
  const z = await zoneAt(client, tenantId, locationId, zoneId);
  if (!z) throw new Error("BAD_REQUEST:Zone not found");
  const checked = await checkEpcsForZone(pool, tenantId, locationId, epcs);
  const ok = checked.filter((c) => c.ok);
  const skipped = checked.filter((c) => !c.ok);
  const todo = ok.filter((c) => c.details.zoneId !== zoneId);
  const up = todo.length
    ? await client.query<{ epc: string; old_zone: string | null }>(
        `WITH prev AS (
           SELECT i.id, i.epc, oz.name AS old_zone
             FROM items i
             LEFT JOIN assigned_zones oz ON oz.id = i.assigned_zone_id
            WHERE i.epc = ANY($1::text[]) AND i.location_id = $2::uuid AND i.status = 'in-stock'
              AND i.assigned_zone_id IS DISTINCT FROM $3::uuid
            FOR UPDATE OF i
         )
         UPDATE items i
            SET assigned_zone_id = $3::uuid, zone_assigned_at = now(), zone_assigned_by = $4::uuid
           FROM prev
          WHERE i.id = prev.id
          RETURNING i.epc, prev.old_zone`,
        [todo.map((c) => c.epc), locationId, zoneId, actor.userId],
      )
    : { rows: [] as { epc: string; old_zone: string | null }[] };
  await auditZone(
    client,
    tenantId,
    up.rows.map((r) => ({ epc: r.epc, old: r.old_zone ?? "(none)", new: z.name, reason: "zone_assign" })),
    actor,
  );
  const done = new Map(up.rows.map((r) => [r.epc.toUpperCase(), r.old_zone]));
  const lines: ZoneReportLine[] = checked.map((c) => {
    if (!c.ok) return { epc: c.epc, result: "skipped", reason: c.reasonText, details: c.details, zoneAfter: c.details.zone };
    if (c.details.zoneId === zoneId) return { epc: c.epc, result: "already in zone", reason: null, details: c.details, zoneAfter: z.name };
    if (done.has(c.epc)) {
      const old = done.get(c.epc);
      return { epc: c.epc, result: old ? "moved" : "assigned", reason: old ? `from ${old}` : null, details: c.details, zoneAfter: z.name };
    }
    return { epc: c.epc, result: "skipped", reason: "Changed while assigning — scan it again", details: c.details, zoneAfter: c.details.zone };
  });
  return {
    assigned: up.rows.filter((r) => !r.old_zone).length,
    moved: up.rows.filter((r) => !!r.old_zone).length,
    alreadyInZone: lines.filter((l) => l.result === "already in zone").length,
    skipped,
    zone: z.name,
    lines,
  };
}

/**
 * Takes the zone off the listed tags (only those in `onlyZoneId` when given).
 * Every listed tag gets a report line: removed / not in this zone / skipped
 * with the reason.
 */
export async function removeEpcsFromZone(
  pool: Pool,
  client: PoolClient,
  tenantId: string,
  locationId: string,
  epcs: string[],
  actor: BinActor,
  onlyZoneId?: string | null,
): Promise<{ removed: number; notInZone: number; lines: ZoneReportLine[] }> {
  const list = [...new Set(epcs.map(normEpc).filter(Boolean))];
  if (list.length === 0) return { removed: 0, notInZone: 0, lines: [] };
  const checked = await checkEpcsForZone(pool, tenantId, locationId, list);
  const up = await client.query<{ epc: string; old_zone: string }>(
    `WITH prev AS (
       SELECT i.id, oz.name AS old_zone
         FROM items i
         JOIN assigned_zones oz ON oz.id = i.assigned_zone_id
        WHERE i.epc = ANY($1::text[]) AND i.location_id = $2::uuid
          AND ($3::uuid IS NULL OR i.assigned_zone_id = $3::uuid)
        FOR UPDATE OF i
     )
     UPDATE items i
        SET assigned_zone_id = NULL, zone_assigned_at = NULL, zone_assigned_by = NULL
       FROM prev
      WHERE i.id = prev.id
      RETURNING i.epc, prev.old_zone`,
    [list, locationId, onlyZoneId ?? null],
  );
  await auditZone(client, tenantId, up.rows.map((r) => ({ epc: r.epc, old: r.old_zone, new: null, reason: "zone_remove" })), actor);
  const removed = new Set(up.rows.map((r) => r.epc.toUpperCase()));
  const lines: ZoneReportLine[] = checked.map((c) => {
    if (removed.has(c.epc)) return { epc: c.epc, result: "removed", reason: null, details: c.details, zoneAfter: null };
    if (!c.details.status && !c.ok) return { epc: c.epc, result: "skipped", reason: c.reasonText, details: c.details, zoneAfter: null };
    return {
      epc: c.epc,
      result: "not in this zone",
      reason: c.details.zone ? `in ${c.details.zone}` : (c.reasonText ?? "in no zone"),
      details: c.details,
      zoneAfter: c.details.zone,
    };
  });
  return { removed: up.rowCount ?? 0, notInZone: list.length - (up.rowCount ?? 0), lines };
}

const ET = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const ZONE_REPORT_HEADER = [
  "EPC", "Result", "Reason", "Product", "Color", "Size", "SKU", "Price", "Status", "Bin", "Extra bins",
  "Location", "Zone before", "Zone after", "Last seen (ET)", "Reader zone last heard", "First seen (ET)", "Serial", "Source",
];

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Saves a zone assign / remove as a report: Reports → Device Upload Logs on
 * the desktop and Reports → Zones on the handheld. One CSV line per tag of
 * the scan, couldn't-assign tags included. Mode reads e.g.
 * "Zone assign · STORE · 1548 done · 12 not". Returns the report id.
 */
export async function writeZoneReport(
  client: PoolClient,
  tenantId: string,
  deviceId: string | null,
  kind: "assign" | "remove",
  zoneName: string,
  lines: ZoneReportLine[],
): Promise<number | null> {
  if (lines.length === 0) return null;
  const done = lines.filter((l) => l.result === "assigned" || l.result === "moved" || l.result === "removed").length;
  const notDone = lines.filter((l) => l.result === "skipped" || l.result === "not in this zone").length;
  const mode = `Zone ${kind} · ${zoneName} · ${done} done · ${notDone} not`;
  const rows = lines.map((l) => {
    const d = l.details;
    return [
      l.epc, l.result, l.reason, d.product, d.color, d.size, d.sku, d.retailPrice, d.statusLabel ?? "Not in WMS",
      d.bin, d.extraBins.join(" "), d.location, d.zone, l.zoneAfter, ET(d.lastSeenAt), d.lastSeenReaderZone,
      ET(d.firstSeenAt), d.serial, d.source,
    ].map(csvCell).join(",");
  });
  const csv = [ZONE_REPORT_HEADER.join(","), ...rows].join("\n") + "\n";
  const r = await client.query<{ id: string }>(
    `INSERT INTO device_upload_logs (tenant_id, device_id, workflow_mode, raw_csv)
     VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`,
    [tenantId, (deviceId ?? "web").slice(0, 200), mode, csv],
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

export type ZoneEpcRow = ZoneTagDetails & { assignedBy: string | null };

/** The LIVE tags in a zone, with product, bins and who assigned them when. */
export async function listZoneEpcs(
  pool: Pool,
  tenantId: string,
  locationId: string,
  zoneId: string,
): Promise<ZoneEpcRow[]> {
  const r = await pool.query<DetailRow & { first_name: string | null; last_name: string | null; email: string | null }>(
    `SELECT q.*, u.first_name, u.last_name, u.email
       FROM (${DETAIL_SELECT}
             WHERE l.tenant_id = $1::uuid AND i.location_id = $2::uuid
               AND i.assigned_zone_id = $3::uuid AND i.status = 'in-stock') q
       JOIN items ii ON ii.epc = q.epc
       LEFT JOIN users u ON u.id = ii.zone_assigned_by
      ORDER BY q.product NULLS LAST, q.color NULLS LAST, q.size NULLS LAST, q.epc`,
    [tenantId, locationId, zoneId],
  );
  // "First L." — never an email.
  return r.rows.map((row) => ({
    ...toDetails(row),
    assignedBy: row.first_name || row.last_name || row.email ? shortName(row.first_name, row.last_name, row.email) : null,
  }));
}
