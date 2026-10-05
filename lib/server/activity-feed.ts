import type { Pool } from "pg";
import {
  describeAction,
  describeRoute,
  keysForModule,
  NOT_A_CHANGE_ACTIONS,
  NOT_A_CHANGE_ROUTES,
  SOURCE_LABEL,
  type ActivityModule,
} from "@/lib/activity-catalog";

/**
 * One feed for the Activity history page, merged from:
 *   - audit_log            — every API change (`api_request`, see withActivity)
 *                            plus the older hand-written actions
 *   - inventory_audit_logs — tag status changes and stock adjustments
 * Every row is resolved into who / module / action / item / source / outcome,
 * with ids in the payload looked up to names.
 */

export type ActivityFilters = {
  limit: number;
  cursor?: { ts: string; id: string } | null;
  from?: string | null;
  to?: string | null;
  userId?: string | null;
  module?: string | null;
  source?: string | null;
  q?: string | null;
  readers?: boolean;
  failedOnly?: boolean;
  /** Only successful calls that leave a lasting change (dashboard). */
  changesOnly?: boolean;
};

export type ActivityItem = {
  epc?: string | null;
  sku?: string | null;
  product?: string | null;
  color?: string | null;
  size?: string | null;
};

export type ActivityRow = {
  id: string;
  at: string;
  cursor: string;
  user: { id: string; name: string | null; email: string | null } | null;
  actor: string;
  module: ActivityModule;
  action: string;
  summary: string | null;
  change: { from: string | null; to: string | null } | null;
  item: ActivityItem | null;
  itemCount: number | null;
  source: string;
  sourceDetail: string | null;
  outcome: "ok" | "failed" | "recorded";
  status: number | null;
  error: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  names: Record<string, string>;
};

const RICH_ROUTES = new Set([
  "inventory/bulk-status",
  "hardware-config/readers/[id]/pause",
  "hardware-config/readers/[id]/resume",
  "hardware-config/readers/pause-all",
  "hardware-config/readers/resume-all",
  "hardware-config/hard-reset",
  "hardware-config/readers/[id]/hard-reset",
  "hardware-config/readers/[id]/monsoon-driver",
  "hardware-config/readers/[id]/schedule",
  "cdm-agents/[id]/recover",
  "inventory/bulk-import/commit",
  "mobile/barcode-intake",
  "rfid/bulk-geiger/promote",
  "rfid/ship-scan-out",
  "rfid/ship-scan-out/undo",
  "webhooks/shopify/orders-paid",
  "webhooks/shopify/orders-fulfilled",
  "webhooks/shopify/refunds-create",
]);

const STATUS_WORD: Record<string, string> = {
  "in-stock": "Live",
  unknown: "Unknown",
  return: "Return",
  damaged: "Damaged",
  sold: "Sold",
  stolen: "Stolen",
  tag_killed: "Tag killed",
  pending_visibility: "Pending visibility",
  "in-transit": "In transit",
  pending_transaction: "Pending transaction",
};
const statusWord = (s: string | null | undefined) => (s ? (STATUS_WORD[s] ?? s) : null);

const REASON_SOURCE: Record<string, [string, string | null]> = {
  catalog_rfid_modal: ["Web", "Catalog → RFID tags"],
  pos_update_status_modal: ["Carbon POS", "Status popup"],
  pos_sale: ["Carbon POS", "Sale"],
  clean_bin: ["Handheld", "Clean bin"],
  bin_move: ["Handheld", "Bin move"],
  bin_add: ["Handheld", "Bin add"],
};

const REASON_WORD: Record<string, string> = {
  bulk_status: "Bulk status change",
  bulk_status_create: "Status set on a tag not yet in the WMS",
  catalog_rfid_modal: "Changed from the catalog's RFID tags popup",
  pos_update_status_modal: "Changed in Carbon POS",
  pos_sale: "Carbon POS sale",
  clean_bin: "Bin cleaned",
  bin_move: "Moved between bins",
  bin_add: "Added to a bin",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EPC = /^[0-9A-F]{24}$/;

type RawRow = {
  id: string;
  ts: string;
  created_at: Date;
  kind: "a" | "i";
  action: string;
  entity: string;
  metadata: Record<string, unknown> | null;
  user_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  device_id: string | null;
  entity_type: string | null;
};

export async function listActivity(pool: Pool, tenantId: string, f: ActivityFilters) {
  const limit = Math.min(300, Math.max(10, f.limit));
  const readers = !!f.readers || f.module === "Reader movements";
  const args: unknown[] = [tenantId, limit];
  const p = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };

  const aw: string[] = ["al.tenant_id = $1::uuid"];
  const iw: string[] = ["l.tenant_id = $1::uuid"];
  if (!readers) aw.push("al.action <> 'rfid_zone_change'");
  if (f.cursor) {
    const ts = p(f.cursor.ts);
    const id = p(f.cursor.id);
    aw.push(`(al.created_at < ${ts}::timestamptz OR (al.created_at = ${ts}::timestamptz AND ('a:' || al.id::text) COLLATE "C" < ${id}::text COLLATE "C"))`);
    iw.push(`(l.created_at < ${ts}::timestamptz OR (l.created_at = ${ts}::timestamptz AND ('i:' || lpad(l.id::text, 12, '0')) COLLATE "C" < ${id}::text COLLATE "C"))`);
  }
  if (f.from) {
    const v = p(f.from);
    aw.push(`al.created_at >= ${v}::timestamptz`);
    iw.push(`l.created_at >= ${v}::timestamptz`);
  }
  if (f.to) {
    const v = p(f.to);
    aw.push(`al.created_at < ${v}::timestamptz`);
    iw.push(`l.created_at < ${v}::timestamptz`);
  }
  if (f.userId) {
    const v = p(f.userId);
    aw.push(`al.user_id = ${v}::uuid`);
    iw.push(`l.user_uuid = ${v}::uuid`);
  }
  if (f.module) {
    const { actions } = keysForModule(f.module);
    const m = p(f.module);
    const acts = p(actions);
    aw.push(`((al.action = 'api_request' AND al.metadata->>'module' = ${m}) OR al.action = ANY(${acts}::text[]))`);
    iw.push(`l.log_type = ANY(${acts}::text[])`);
  }
  if (f.source) {
    const v = p(f.source);
    aw.push(`al.metadata->>'source' = ${v}`);
    if (f.source === "handheld") iw.push(`l.device_id IS NOT NULL`);
    else if (f.source === "web") iw.push(`l.reason = 'catalog_rfid_modal'`);
    else iw.push("false");
  }
  if (f.failedOnly) {
    aw.push(`al.metadata->>'ok' = 'false'`);
    iw.push("false");
  }
  if (f.changesOnly) {
    const routes = p([...NOT_A_CHANGE_ROUTES]);
    const actions = p([...NOT_A_CHANGE_ACTIONS]);
    aw.push(`(CASE WHEN al.action = 'api_request'
               THEN al.metadata->>'ok' = 'true' AND al.metadata->>'method' <> 'GET'
                    AND NOT (coalesce(al.metadata->>'route', '') = ANY(${routes}::text[]))
               ELSE NOT (al.action = ANY(${actions}::text[])) END)`);
  }
  let matched = "";
  if (f.q?.trim()) {
    const q = p(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    matched = `, m_sku AS MATERIALIZED (
        SELECT cs.id, cs.matrix_id FROM custom_skus cs JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.sku ILIKE ${q} OR cs.upc ILIKE ${q} OR m.description ILIKE ${q} OR m.upc ILIKE ${q}
        LIMIT 2000
      ), m_epc AS MATERIALIZED (
        SELECT i.epc FROM items i WHERE i.custom_sku_id IN (SELECT id FROM m_sku) LIMIT 20000
      )`;
    aw.push(`(al.entity ILIKE ${q} OR al.metadata::text ILIKE ${q} OR u.email ILIKE ${q}
              OR (u.first_name || ' ' || coalesce(u.last_name, '')) ILIKE ${q}
              OR al.metadata->>'epc' IN (SELECT epc FROM m_epc)
              OR al.metadata->'params'->>'id' IN (SELECT matrix_id::text FROM m_sku UNION SELECT id::text FROM m_sku))`);
    iw.push(`(l.entity_reference ILIKE ${q} OR l.reason ILIKE ${q} OR u.email ILIKE ${q}
              OR (u.first_name || ' ' || coalesce(u.last_name, '')) ILIKE ${q}
              OR l.entity_reference IN (SELECT epc FROM m_epc))`);
  }

  const sql = `
    WITH base AS (SELECT 1)${matched},
    a AS (
      SELECT 'a:' || al.id::text AS id, al.created_at, 'a' AS kind, al.action, al.entity, al.metadata,
             al.user_id::text AS user_id, u.email, u.first_name, u.last_name,
             NULL::text AS old_value, NULL::text AS new_value, NULL::text AS reason,
             NULL::text AS device_id, NULL::text AS entity_type
      FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
      WHERE ${aw.join(" AND ")}
      ORDER BY al.created_at DESC, ('a:' || al.id::text) COLLATE "C" DESC
      LIMIT $2
    ),
    i AS (
      SELECT 'i:' || lpad(l.id::text, 12, '0') AS id, l.created_at, 'i' AS kind, l.log_type AS action,
             l.entity_reference AS entity, NULL::jsonb AS metadata,
             l.user_uuid::text AS user_id, u.email, u.first_name, u.last_name,
             l.old_value::text, l.new_value::text, l.reason, l.device_id::text, l.entity_type::text
      FROM inventory_audit_logs l LEFT JOIN users u ON u.id = l.user_uuid
      WHERE ${iw.join(" AND ")}
      ORDER BY l.created_at DESC, ('i:' || lpad(l.id::text, 12, '0')) COLLATE "C" DESC
      LIMIT $2
    )
    SELECT x.*, x.created_at::text AS ts FROM (SELECT * FROM a UNION ALL SELECT * FROM i) x
    ORDER BY x.created_at DESC, x.id COLLATE "C" DESC
    LIMIT $2`;

  const client = await pool.connect();
  let raw: RawRow[];
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '25s'");
    raw = (await client.query<RawRow>(sql, args)).rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const rows = raw.map(shape);
  const merged = mergeCompanions(rows);
  await resolveNames(pool, tenantId, merged);
  const last = raw[raw.length - 1];
  return {
    rows: merged,
    nextCursor: raw.length === limit && last ? { ts: last.ts, id: last.id } : null,
  };
}

function personName(r: RawRow): string | null {
  const n = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return n || null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function epcsFrom(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["epc", "epcs", "tagEpcs", "oldEpc", "newEpc"]) {
    const v = b[k];
    if (typeof v === "string" && EPC.test(v)) out.push(v);
    if (Array.isArray(v)) for (const e of v) if (typeof e === "string" && EPC.test(e)) out.push(e);
  }
  return out;
}

function countFrom(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 1) {
      const tail = v[v.length - 1];
      const m = typeof tail === "string" ? tail.match(/\((\d+) total\)$/) : null;
      return m ? Number(m[1]) : v.length;
    }
  }
  return null;
}

const SKIP_SUMMARY_KEYS = new Set(["epc", "epcs", "reason", "deviceId", "override"]);

function summarizeBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b._upload) return "File upload";
  if (typeof b._omitted === "string") return b._omitted;
  const bits: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (SKIP_SUMMARY_KEYS.has(k) || v == null || v === "") continue;
    if (typeof v === "string" && UUID.test(v)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      bits.push(`${k}: ${s.length > 60 ? `${s.slice(0, 60)}…` : s}`);
    } else if (Array.isArray(v)) bits.push(`${k}: ${countFrom({ [k]: v }) ?? v.length} item(s)`);
    else bits.push(k);
    if (bits.length >= 6) break;
  }
  return bits.length ? bits.join(" · ") : null;
}

function shape(r: RawRow): ActivityRow {
  const user = r.user_id ? { id: r.user_id, name: personName(r), email: r.email } : null;
  const base = {
    id: r.id,
    at: r.created_at.toISOString(),
    cursor: r.ts,
    user,
    actor: personName(r) ?? r.email ?? "",
    change: null as ActivityRow["change"],
    item: null as ActivityItem | null,
    itemCount: null as number | null,
    status: null as number | null,
    error: null as string | null,
    reason: null as string | null,
    names: {} as Record<string, string>,
  };

  if (r.kind === "i") {
    const d = describeAction(r.action);
    const [src, srcDetail] = r.device_id
      ? /agent|script|repair/i.test(r.device_id)
        ? ["System", `Maintenance script (${r.device_id})`]
        : ["Handheld", r.device_id]
      : (REASON_SOURCE[r.reason ?? ""] ?? ["Not recorded", null]);
    const isStatus = r.action === "STATUS_CHANGE";
    return {
      ...base,
      actor: base.actor || (src === "Carbon POS" ? "Carbon POS" : "Not recorded"),
      module: d.module,
      action: d.label,
      summary: isStatus ? `${statusWord(r.old_value) ?? "—"} → ${statusWord(r.new_value) ?? "—"}` : r.old_value || r.new_value ? `${r.old_value ?? "—"} → ${r.new_value ?? "—"}` : null,
      change: { from: isStatus ? statusWord(r.old_value) : r.old_value, to: isStatus ? statusWord(r.new_value) : r.new_value },
      item: r.entity_type === "EPC" ? { epc: r.entity } : { sku: r.entity },
      source: src,
      sourceDetail: srcDetail,
      outcome: "recorded",
      reason: r.reason ? (REASON_WORD[r.reason] ?? r.reason) : null,
      details: {
        log: r.action,
        entity_type: r.entity_type,
        entity: r.entity,
        old_value: r.old_value,
        new_value: r.new_value,
        reason: r.reason,
        device_id: r.device_id,
      },
    };
  }

  const m = r.metadata ?? {};
  if (r.action === "api_request") {
    const method = str(m.method) ?? "";
    const route = str(m.route) ?? r.entity;
    const d = str(m.module) && str(m.label) ? { module: m.module as ActivityModule, label: m.label as string } : describeRoute(method, route);
    const epcs = epcsFrom(m.body);
    const ok = m.ok !== false;
    const source = str(m.source) ?? "external";
    const body = m.body as Record<string, unknown> | undefined;
    const target = body && typeof body.targetStatus === "string" ? statusWord(body.targetStatus) : null;
    const orderName =
      body && typeof body.orderName === "string"
        ? body.orderName
        : route.startsWith("webhooks/shopify/") && body
          ? typeof body.name === "string"
            ? body.name
            : typeof body.order_id === "number" || typeof body.order_id === "string"
              ? `order ${body.order_id}`
              : null
          : null;
    return {
      ...base,
      actor: base.actor || str(m.user_email) || (source === "shopify_webhook" ? "Shopify" : source === "machine" ? "System" : "Not signed in"),
      module: d.module,
      action: d.label,
      summary: target
        ? `→ ${target}`
        : orderName
          ? `Order ${orderName.replace(/^order\s+/i, "")}`
          : summarizeBody(m.body),
      change: target ? { from: null, to: target } : null,
      item: epcs.length === 1 ? { epc: epcs[0] } : null,
      itemCount: epcs.length > 1 ? (countFrom(m.body) ?? epcs.length) : null,
      source: SOURCE_LABEL[source] ?? source,
      sourceDetail: source === "handheld" ? (str(m.deviceId) ?? null) : (str(m.page) ?? null),
      outcome: ok ? "ok" : "failed",
      status: typeof m.status === "number" ? m.status : null,
      error: str(m.error),
      details: m,
    };
  }

  const d = describeAction(r.action);
  const epc = str(m.epc) ?? (r.entity.startsWith("epc:") ? r.entity.slice(4) : null);
  let source = "Not recorded";
  let sourceDetail: string | null = null;
  if (r.action === "rfid_zone_change") {
    source = "Fixed reader";
    sourceDetail = str(m.reader_name);
  } else if (r.action.startsWith("cdm_agent_auto_")) {
    source = "System";
    sourceDetail = "Reader network discovery";
  } else if (r.action === "lightspeed_catalog_sync") {
    source = "Background job";
  } else if (r.action === "item_live_transition") {
    source = "System";
    sourceDetail = m.cycle_count_session_id ? "Cycle count" : null;
  } else if (r.user_id) {
    source = "Web";
  }
  let summary: string | null = null;
  let change: ActivityRow["change"] = null;
  if (r.action === "item_live_transition") {
    change = { from: statusWord(str(m.previous_status)), to: statusWord(str(m.new_status)) };
    summary = `${change.from ?? "—"} → ${change.to ?? "—"}${m.outcome ? ` (${String(m.outcome).replace(/_/g, " ")})` : ""}`;
  } else if (typeof m.paused_count === "number") summary = `${m.paused_count} reader(s)`;
  else if (typeof m.resumed_count === "number") summary = `${m.resumed_count} reader(s)`;
  else if (typeof m.summary === "string") summary = m.summary;
  else if (m.status && typeof m.status === "string") summary = m.status;
  return {
    ...base,
    actor: base.actor || (source === "Fixed reader" ? (sourceDetail ?? "Reader") : source === "Not recorded" ? "Not recorded" : source),
    module: d.module,
    action: d.label,
    summary,
    change,
    item: epc ? { epc } : null,
    source,
    sourceDetail,
    outcome: "recorded",
    details: m,
  };
}

/** A route that also writes its own detailed row: keep the detailed row, give
 *  it the request's source, and drop the request row (unless it failed — then
 *  no detailed row exists and the failure itself is the record). */
function mergeCompanions(rows: ActivityRow[]): ActivityRow[] {
  const drop = new Set<string>();
  for (const r of rows) {
    if (!r.id.startsWith("a:") || r.outcome !== "ok") continue;
    const route = str(r.details.route);
    if (!route || !RICH_ROUTES.has(route)) continue;
    // The request row is written when the handler returns; its detailed rows
    // were written while it ran — inside [end − duration, end].
    const t = Date.parse(r.at);
    const ran = typeof r.details.ms === "number" ? r.details.ms : 15000;
    let matched = false;
    for (const o of rows) {
      if (o === r || o.outcome !== "recorded" || (o.user?.id ?? null) !== (r.user?.id ?? null)) continue;
      if (o.details.request) continue; // already paired with another request
      // Tag-level rows (status changes, stock) pair with any tag-changing
      // request; hand-written rows pair only within the same module.
      if (!o.id.startsWith("i:") && o.module !== r.module) continue;
      const dt = t - Date.parse(o.at);
      if (dt < -50 || dt > ran + 50) continue;
      matched = true;
      // The request names the real action ("Scanned out", "Shopify refund");
      // the detailed row carries the item and the before → after.
      o.action = r.action;
      o.module = r.module;
      if (r.summary?.startsWith("Order ")) o.reason = r.summary;
      else if (o.reason && /^[a-z_]+( #\S+)?$/.test(o.reason)) o.reason = null; // raw code
      if (!o.user && (o.actor === "Not recorded" || !o.actor)) o.actor = r.actor;
      o.source = r.source;
      o.sourceDetail = r.sourceDetail;
      o.details = { ...o.details, request: r.details };
    }
    if (matched) drop.add(r.id);
  }
  return rows.filter((r) => !drop.has(r.id));
}

function collectIds(v: unknown, out: Set<string>, depth = 0) {
  if (depth > 3 || v == null) return;
  if (typeof v === "string") {
    if (UUID.test(v)) out.add(v.toLowerCase());
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) collectIds(x, out, depth + 1);
    return;
  }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collectIds(x, out, depth + 1);
}

async function resolveNames(pool: Pool, tenantId: string, rows: ActivityRow[]) {
  const ids = new Set<string>();
  const epcs = new Set<string>();
  const deviceKeys = new Set<string>();
  for (const r of rows) {
    if (r.item?.epc) epcs.add(r.item.epc);
    const d = r.details;
    collectIds({ params: d.params, body: d.body, query: d.query, location_id: d.location_id }, ids);
    for (const k of ["device_id", "reader_id", "to_zone_id", "from_zone_id", "agent_id", "session_id", "to_location_id", "from_location_id", "transfer_id"]) {
      const v = d[k];
      if (typeof v === "string" && UUID.test(v)) ids.add(v.toLowerCase());
    }
    if (r.source === "Handheld" && r.sourceDetail) deviceKeys.add(r.sourceDetail);
  }

  const names = new Map<string, string>();
  if (ids.size) {
    const list = [...ids];
    const q = await pool.query<{ id: string; label: string }>(
      `SELECT id::text, coalesce(description, upc) AS label FROM matrices WHERE id = ANY($1::uuid[])
       UNION ALL SELECT cs.id::text, cs.sku || coalesce(' · ' || m.description, '') FROM custom_skus cs LEFT JOIN matrices m ON m.id = cs.matrix_id WHERE cs.id = ANY($1::uuid[])
       UNION ALL SELECT id::text, name FROM devices WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid
       UNION ALL SELECT id::text, name FROM zones WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid
       UNION ALL SELECT id::text, coalesce(code || ' — ', '') || name FROM locations WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid
       UNION ALL SELECT id::text, name FROM cdm_agents WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid
       UNION ALL SELECT id::text, coalesce(nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''), email) FROM users WHERE id = ANY($1::uuid[])`,
      [list, tenantId],
    );
    for (const row of q.rows) if (row.label) names.set(row.id, row.label);
  }

  const items = new Map<string, ActivityItem>();
  if (epcs.size) {
    const q = await pool.query<{ epc: string; sku: string | null; product: string | null; color: string | null; size: string | null }>(
      `SELECT i.epc, cs.sku, m.description AS product, cs.color_code AS color, cs.size
       FROM items i LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id LEFT JOIN matrices m ON m.id = cs.matrix_id
       WHERE i.epc = ANY($1::text[])`,
      [[...epcs]],
    );
    for (const row of q.rows) items.set(row.epc, row);
  }

  const devices = new Map<string, string>();
  if (deviceKeys.size) {
    const keys = [...deviceKeys];
    const q = await pool.query<{ key: string; name: string }>(
      `SELECT k AS key, d.name FROM unnest($1::text[]) k
       JOIN devices d ON d.tenant_id = $2::uuid AND (d.android_id = k OR d.name = k OR d.id::text = k)`,
      [keys, tenantId],
    );
    for (const row of q.rows) devices.set(row.key, row.name);
  }

  for (const r of rows) {
    const mine = new Set<string>();
    collectIds({ params: r.details.params, body: r.details.body, query: r.details.query }, mine);
    for (const k of ["device_id", "reader_id", "to_zone_id", "from_zone_id", "agent_id", "to_location_id", "from_location_id"]) {
      const v = r.details[k];
      if (typeof v === "string" && UUID.test(v)) mine.add(v.toLowerCase());
    }
    for (const id of mine) {
      const n = names.get(id);
      if (n) r.names[id] = n;
    }
    if (r.item?.epc) {
      const it = items.get(r.item.epc);
      if (it) r.item = { ...r.item, ...it };
    }
    if (r.source === "Handheld" && r.sourceDetail) r.sourceDetail = devices.get(r.sourceDetail) ?? r.sourceDetail;
    if (r.module === "Reader movements") {
      const from = names.get(String(r.details.from_zone_id ?? "").toLowerCase());
      const to = names.get(String(r.details.to_zone_id ?? "").toLowerCase());
      if (from || to) r.summary = `${from ?? "—"} → ${to ?? "—"}`;
    }
    // Target named in the URL (e.g. the product being edited).
    const params = r.details.params as Record<string, unknown> | undefined;
    if (!r.item && params) {
      for (const v of Object.values(params)) {
        const n = typeof v === "string" ? names.get(v.toLowerCase()) : undefined;
        if (n) {
          r.item = { product: n };
          break;
        }
      }
    }
  }
}
