import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { ingestEpcs, loadEpcConfig } from "@/lib/server/epc-ingress";
import { decodeEpc } from "@/lib/server/epc-decode";
import { legacyEpcSystemId } from "@/lib/server/legacy-epc-catalog";
import { applyManualItemOverride } from "@/lib/server/manual-item-qty";

/**
 * Count review & push (owner, 2026-10-15).
 *
 * A full count is a mobile Count file plus the Add-On files scanned against
 * it. Nothing showed them together, and nothing could push the result after a
 * review — the only option was each phone's own upload. Here the operator
 * picks the files, sees the combined result against the live WMS, and pushes
 * it once:
 *
 *   add       — scanned tags that are unknown, new, or live at another
 *               location go live here. Nothing else changes.
 *   override  — the same, and every tag LIVE at this location that the count
 *               did not see goes to 'unknown' (a later scan brings it back).
 *
 * Killed tags found on the shelf are never revived by a scan (owner rule);
 * a super-admin may tick them on the review to bring them back. Non-RFID
 * manual stock is never touched unless "zero out manual stock" is ticked.
 * A file can be pushed once (inventory_reports.pushed_at).
 */

export const COUNT_ACTIVITIES = ["MOBILE COUNT", "ADD-ON COUNT"] as const;
const LIST_CAP = 3000;

export type CountFile = {
  id: string;
  activity: string;
  filename: string;
  rowCount: number;
  uploadedAt: string;
  deviceId: string | null;
  uploadedBy: string;
  pushedAt: string | null;
  pushMode: string | null;
};

export type TagRow = {
  epc: string;
  status: string;
  product: string | null;
  upc: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
  lastSeenAt: string | null;
  location: string | null;
  file: string | null;
};

export type ManualRow = { customSkuId: string; sku: string; product: string | null; color: string | null; size: string | null; qty: number };

export type CountReview = {
  locationId: string;
  locationName: string;
  files: CountFile[];
  alreadyPushed: CountFile[];
  scanned: number;
  perFile: Array<{ id: string; filename: string; tags: number; newToCombined: number }>;
  alreadyLive: number;
  willGoLive: TagRow[];
  liveElsewhere: TagRow[];
  newTags: TagRow[];
  defective: TagRow[];
  killedProducts: TagRow[];
  killedNoProduct: TagRow[];
  otherStatus: TagRow[];
  missing: TagRow[];
  missingTotal: number;
  manual: ManualRow[];
  manualUnits: number;
};

const short = (f?: string | null, l?: string | null, e?: string | null) => {
  const a = (f ?? "").trim();
  const b = (l ?? "").trim();
  if (a && b) return `${a} ${b[0]!.toUpperCase()}.`;
  return a || b || (e ? e.split("@")[0]! : "");
};

/** RFC-4180-ish CSV → rows (quoted fields may hold commas and doubled quotes). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

/** The EPCs in one stored count CSV (24-hex only, upper-cased, deduped). */
export function epcsFromCsv(text: string): string[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const ix = head.findIndex((h) => h === "epc" || h === "tag" || h === "epc_hex");
  if (ix < 0) return [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const e = (r[ix] ?? "").replace(/\s/g, "").toUpperCase();
    if (/^[0-9A-F]{24}$/.test(e)) seen.add(e);
  }
  return [...seen];
}

/** Recent Count / Add-On files, newest first, with who uploaded and whether pushed. */
export async function listCountFiles(pool: Pool, tenantId: string, days = 30): Promise<CountFile[]> {
  const r = await pool.query<{
    id: string; activity: string; filename: string; row_count: number; uploaded_at: Date; device_id: string | null;
    first_name: string | null; last_name: string | null; email: string | null; pushed_at: Date | null; mode: string | null;
  }>(
    `SELECT r.id::text, r.activity, r.filename, r.row_count, r.uploaded_at, r.device_id,
            u.first_name, u.last_name, u.email, r.pushed_at, p.mode
       FROM inventory_reports r
       LEFT JOIN users u ON u.id::text = r.uploaded_by::text
       LEFT JOIN count_pushes p ON p.id = r.push_id
      WHERE r.tenant_id = $1::uuid
        AND r.activity = ANY($2::text[])
        AND r.uploaded_at > now() - ($3::int || ' days')::interval
      ORDER BY r.uploaded_at DESC
      LIMIT 500`,
    [tenantId, COUNT_ACTIVITIES as unknown as string[], days],
  );
  return r.rows.map((x) => ({
    id: x.id,
    activity: x.activity,
    filename: x.filename,
    rowCount: Number(x.row_count) || 0,
    uploadedAt: x.uploaded_at.toISOString(),
    deviceId: x.device_id,
    uploadedBy: short(x.first_name, x.last_name, x.email),
    pushedAt: x.pushed_at ? x.pushed_at.toISOString() : null,
    pushMode: x.mode,
  }));
}

type Exec = Pool | PoolClient;

async function loadFiles(q: Exec, tenantId: string, reportIds: string[], lock: boolean) {
  const r = await q.query<{ id: string; activity: string; filename: string; row_count: number; uploaded_at: Date; device_id: string | null; csv_content: string | null; pushed_at: Date | null }>(
    `SELECT id::text, activity, filename, row_count, uploaded_at, device_id, csv_content, pushed_at
       FROM inventory_reports
      WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND activity = ANY($3::text[])
      ORDER BY uploaded_at${lock ? " FOR UPDATE" : ""}`,
    [tenantId, reportIds, COUNT_ACTIVITIES as unknown as string[]],
  );
  return r.rows;
}

const tagSelect = `SELECT i.epc, i.status, i.custom_sku_id::text AS custom_sku_id, i.location_id::text AS location_id,
       i.last_seen_at, b.code AS bin, cs.sku, cs.color_code AS color, cs.size, m.description AS product, m.upc, l.name AS location
  FROM items i
  JOIN locations l ON l.id = i.location_id
  LEFT JOIN bins b ON b.id = i.bin_id
  LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
  LEFT JOIN matrices m ON m.id = cs.matrix_id`;

type DbTag = {
  epc: string; status: string; custom_sku_id: string | null; location_id: string; last_seen_at: Date | null;
  bin: string | null; sku: string | null; color: string | null; size: string | null; product: string | null; upc: string | null; location: string | null;
};

const toRow = (t: DbTag, file: string | null): TagRow => ({
  epc: t.epc,
  status: t.status,
  product: t.product,
  upc: t.upc,
  sku: t.sku,
  color: t.color,
  size: t.size,
  bin: t.bin,
  lastSeenAt: t.last_seen_at ? t.last_seen_at.toISOString() : null,
  location: t.location,
  file,
});

const byProduct = (a: TagRow, b: TagRow) =>
  String(a.upc ?? "~").localeCompare(String(b.upc ?? "~")) || String(a.sku ?? "").localeCompare(String(b.sku ?? "")) || a.epc.localeCompare(b.epc);

/** Does a tag with no items row decode to a catalog SKU (primary or legacy formula)? */
async function decodesToProduct(q: Exec, tenantId: string, epcs: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  if (!epcs.length) return ok;
  const client = q as PoolClient;
  const config = await loadEpcConfig(client, tenantId);
  for (const epc of epcs) {
    const ids: string[] = [];
    if (config) {
      const d = decodeEpc(epc, config);
      if (d.valid && d.systemId !== null) ids.push(d.systemId.toString());
    }
    const legacy = legacyEpcSystemId(epc);
    if (legacy !== null) ids.push(legacy.toString());
    if (!ids.length) continue;
    const r = await q.query(`SELECT 1 FROM custom_skus WHERE ls_system_id = ANY($1::bigint[]) LIMIT 1`, [ids]);
    if (r.rowCount) ok.add(epc);
  }
  return ok;
}

/** The combined result of [reportIds] against the live WMS at [locationId]. Read-only. */
export async function reviewCount(
  q: Exec,
  args: { tenantId: string; locationId: string; reportIds: string[]; lock?: boolean },
): Promise<CountReview & { scannedSet: Map<string, string> }> {
  const files = await loadFiles(q, args.tenantId, args.reportIds, !!args.lock);
  const loc = await q.query<{ name: string }>(`SELECT name FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid`, [args.locationId, args.tenantId]);
  const scanned = new Map<string, string>();
  const perFile: CountReview["perFile"] = [];
  for (const f of files) {
    const epcs = epcsFromCsv(f.csv_content ?? "");
    let fresh = 0;
    for (const e of epcs) {
      if (!scanned.has(e)) {
        scanned.set(e, f.filename);
        fresh++;
      }
    }
    perFile.push({ id: f.id, filename: f.filename, tags: epcs.length, newToCombined: fresh });
  }
  const all = [...scanned.keys()];
  const tags = all.length
    ? (await q.query<DbTag>(`${tagSelect} WHERE l.tenant_id = $1::uuid AND i.epc = ANY($2::text[])`, [args.tenantId, all])).rows
    : [];
  const known = new Map(tags.map((t) => [t.epc.toUpperCase(), t]));

  let alreadyLive = 0;
  const willGoLive: TagRow[] = [];
  const liveElsewhere: TagRow[] = [];
  const killedProducts: TagRow[] = [];
  const killedNoProduct: TagRow[] = [];
  const otherStatus: TagRow[] = [];
  for (const t of tags) {
    const file = scanned.get(t.epc.toUpperCase()) ?? null;
    if (t.status === "in-stock") {
      if (t.location_id === args.locationId) alreadyLive++;
      else liveElsewhere.push(toRow(t, file));
    } else if (t.status === "unknown") willGoLive.push(toRow(t, file));
    else if (t.status === "tag_killed") (t.custom_sku_id ? killedProducts : killedNoProduct).push(toRow(t, file));
    else otherStatus.push(toRow(t, file));
  }
  const unseen = all.filter((e) => !known.has(e));
  const decodable = await decodesToProduct(q, args.tenantId, unseen);
  const blank = (epc: string): TagRow => ({ epc, status: "none", product: null, upc: null, sku: null, color: null, size: null, bin: null, lastSeenAt: null, location: null, file: scanned.get(epc) ?? null });
  const newTags = unseen.filter((e) => decodable.has(e)).map(blank);
  const defective = unseen.filter((e) => !decodable.has(e)).map(blank);

  const missingCount = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM items i WHERE i.location_id = $1::uuid AND i.status = 'in-stock' AND NOT (i.epc = ANY($2::text[]))`,
    [args.locationId, all],
  );
  const missing = (
    await q.query<DbTag>(
      `${tagSelect} WHERE i.location_id = $1::uuid AND i.status = 'in-stock' AND NOT (i.epc = ANY($2::text[]))
        ORDER BY m.upc NULLS LAST, cs.sku, i.epc LIMIT ${LIST_CAP}`,
      [args.locationId, all],
    )
  ).rows.map((t) => toRow(t, null));

  const manualRows = await q.query<{ custom_sku_id: string; sku: string; product: string | null; color: string | null; size: string | null; qty: number }>(
    `SELECT mq.custom_sku_id::text, cs.sku, m.description AS product, cs.color_code AS color, cs.size, mq.current_qty AS qty
       FROM manual_item_qty mq
       JOIN custom_skus cs ON cs.id = mq.custom_sku_id
       LEFT JOIN matrices m ON m.id = cs.matrix_id
      WHERE mq.location_id = $1::uuid AND mq.current_qty > 0
      ORDER BY m.upc NULLS LAST, cs.sku`,
    [args.locationId],
  );
  const manual = manualRows.rows.map((x) => ({ customSkuId: x.custom_sku_id, sku: x.sku, product: x.product, color: x.color, size: x.size, qty: Number(x.qty) || 0 }));

  const fileMeta = files.map((f) => ({
    id: f.id,
    activity: f.activity,
    filename: f.filename,
    rowCount: Number(f.row_count) || 0,
    uploadedAt: f.uploaded_at.toISOString(),
    deviceId: f.device_id,
    uploadedBy: "",
    pushedAt: f.pushed_at ? f.pushed_at.toISOString() : null,
    pushMode: null,
  }));
  return {
    locationId: args.locationId,
    locationName: loc.rows[0]?.name ?? "",
    files: fileMeta,
    alreadyPushed: fileMeta.filter((f) => f.pushedAt),
    scanned: all.length,
    perFile,
    alreadyLive,
    willGoLive: willGoLive.sort(byProduct),
    liveElsewhere: liveElsewhere.sort(byProduct),
    newTags,
    defective,
    killedProducts: killedProducts.sort(byProduct),
    killedNoProduct,
    otherStatus: otherStatus.sort(byProduct),
    missing,
    missingTotal: Number(missingCount.rows[0]?.n ?? 0),
    manual,
    manualUnits: manual.reduce((a, m) => a + m.qty, 0),
    scannedSet: scanned,
  };
}

export type PushArgs = {
  tenantId: string;
  locationId: string;
  userId: string | null;
  userName: string | null;
  isSuperAdmin: boolean;
  reportIds: string[];
  mode: "add" | "override";
  /** Override only: the number of tags the operator saw would go to unknown. */
  confirmZeroCount?: number | null;
  /** Super-admin only: killed tags (scanned, with a product) to bring back live. */
  reviveEpcs?: string[];
  /** Override only: also set every non-RFID manual quantity at this location to 0. */
  zeroManual?: boolean;
};

export type PushResult = {
  pushId: string;
  mode: "add" | "override";
  scanned: number;
  wentLive: number;
  stayedSame: number;
  revived: number;
  zeroedToUnknown: number;
  manualZeroed: number;
  manualUnitsZeroed: number;
};

export class CountPushError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/** Push the combined count, once, in one transaction. */
export async function pushCount(pool: Pool, a: PushArgs): Promise<PushResult> {
  if (!a.reportIds.length) throw new CountPushError("no_files", "Pick the count files to push.");
  const revive = [...new Set((a.reviveEpcs ?? []).map((e) => e.trim().toUpperCase()).filter((e) => /^[0-9A-F]{24}$/.test(e)))];
  if (revive.length && !a.isSuperAdmin) throw new CountPushError("forbidden", "Only a super-admin may bring killed tags back.", 403);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    const rv = await reviewCount(client, { tenantId: a.tenantId, locationId: a.locationId, reportIds: a.reportIds, lock: true });
    if (rv.files.length !== a.reportIds.length) throw new CountPushError("files_missing", "Some of the picked files are not count files of this account.");
    if (rv.alreadyPushed.length) {
      throw new CountPushError("already_pushed", `Already pushed: ${rv.alreadyPushed.map((f) => f.filename).join(", ")}. A file is pushed once.`, 409);
    }
    if (a.mode === "override" && Number(a.confirmZeroCount) !== rv.missingTotal) {
      throw new CountPushError(
        "confirm_mismatch",
        `Stock changed since the review: ${rv.missingTotal} tags would now go to unknown, not ${a.confirmZeroCount ?? "—"}. Review again before pushing.`,
        409,
      );
    }
    const pushId = randomUUID();
    const now = new Date();

    /* 1. Unknown, new, or live elsewhere → live here. The ingest keeps every
          other status as it is (a scan never revives killed / sold / damaged). */
    const toIngest = [...rv.willGoLive, ...rv.liveElsewhere, ...rv.newTags, ...rv.defective].map((t) => t.epc);
    const results = toIngest.length
      ? await ingestEpcs(
          client,
          toIngest.map((epc) => ({
            tenantId: a.tenantId,
            epc,
            source: "count_inventory" as const,
            sourceDeviceLabel: "Count push",
            locationId: a.locationId,
            receivedAt: now,
            auditUserId: a.userId,
            auditReason: "count_push",
          })),
        )
      : [];
    const wentLive = results.filter((r) => !r.kept && r.status === "in-stock").length;

    /* 2. Killed tags a super-admin chose to bring back (scanned, with a product). */
    let revived = 0;
    if (revive.length) {
      const allowed = new Set(rv.killedProducts.map((t) => t.epc.toUpperCase()));
      const ok = revive.filter((e) => allowed.has(e));
      if (ok.length) {
        /* items_block_auto_revive (0089) silently keeps killed tags killed unless
           the write says this is a deliberate revive — like the bulk-status page. */
        await client.query("SET LOCAL app.allow_status_revive = 'on'");
        const r = await client.query(
          `WITH upd AS (
             UPDATE items i SET status = 'in-stock', location_id = $2::uuid, last_seen_at = now()
               FROM locations l
              WHERE l.id = i.location_id AND l.tenant_id = $1::uuid AND i.epc = ANY($3::text[]) AND i.status = 'tag_killed'
              RETURNING i.epc)
           INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid)
           SELECT $1::uuid, 'STATUS_CHANGE', 'EPC', epc, 'tag_killed', 'in-stock', 'count_push_revive', NULL, $4::uuid FROM upd`,
          [a.tenantId, a.locationId, ok, a.userId],
        );
        revived = r.rowCount ?? 0;
        await client.query("SET LOCAL app.allow_status_revive = 'off'");
      }
    }

    /* 3. Override: every tag live here that the count did not see → unknown. */
    let zeroedToUnknown = 0;
    let manualZeroed = 0;
    let manualUnitsZeroed = 0;
    if (a.mode === "override") {
      const keep = [...rv.scannedSet.keys()];
      const r = await client.query(
        `WITH upd AS (
           UPDATE items i SET status = 'unknown', last_seen_at = i.last_seen_at
            WHERE i.location_id = $2::uuid AND i.status = 'in-stock' AND NOT (i.epc = ANY($3::text[]))
            RETURNING i.epc)
         INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid)
         SELECT $1::uuid, 'STATUS_CHANGE', 'EPC', epc, 'in-stock', 'unknown', 'count_override', NULL, $4::uuid FROM upd`,
        [a.tenantId, a.locationId, keep, a.userId],
      );
      zeroedToUnknown = r.rowCount ?? 0;

      /* 4. Non-RFID manual stock — only when ticked. */
      if (a.zeroManual) {
        for (const m of rv.manual) {
          await applyManualItemOverride(client, {
            customSkuId: m.customSkuId,
            locationId: a.locationId,
            newQty: 0,
            source: "cycle_count",
            changedByUserId: a.userId,
            changedByUserName: a.userName,
            notes: "Count push — override entire stock (manual stock zeroed)",
            referenceId: pushId,
          });
          manualZeroed++;
          manualUnitsZeroed += m.qty;
        }
      }
    }

    const result: PushResult = {
      pushId,
      mode: a.mode,
      scanned: rv.scanned,
      wentLive,
      stayedSame: rv.scanned - wentLive - revived,
      revived,
      zeroedToUnknown,
      manualZeroed,
      manualUnitsZeroed,
    };
    await client.query(
      `INSERT INTO count_pushes (id, tenant_id, location_id, pushed_by, mode, report_ids, summary)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid[], $7::jsonb)`,
      [pushId, a.tenantId, a.locationId, a.userId, a.mode, a.reportIds, JSON.stringify({ ...result, files: rv.perFile })],
    );
    await client.query(
      `UPDATE inventory_reports SET pushed_at = now(), pushed_by = $3::uuid, push_id = $4::uuid
        WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
      [a.tenantId, a.reportIds, a.userId, pushId],
    );
    /* Shopify quantities follow now rather than at the worker's next round. */
    await client.query(
      `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
       SELECT $1::uuid, $2::uuid, 'shopify_inventory_sync', 'queued', $3, '{"full":false,"trigger":"count_push"}'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM sync_jobs WHERE job_type = 'shopify_inventory_sync' AND status IN ('queued','running'))`,
      [a.tenantId, a.locationId, `shopify_inventory_sync:count_push:${pushId}`],
    );
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
