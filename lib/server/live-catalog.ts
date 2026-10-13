import type { Pool, PoolClient } from "pg";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";
import { loadGhostWmsStatuses } from "@/lib/server/status-label-enforcement";

/**
 * Live catalog for the handheld (Add-On Catalog / Add-On Count).
 *
 * The phone keeps its own copy of every tenant EPC's status + item info so it
 * can decide each tag locally the instant it is read. It downloads a full
 * snapshot once (entry / no saved copy / > 12 h / reset) and then pulls a tiny
 * delta every ~3 s while scanning.
 *
 * Change tracking (migration 0112): every tracked row carries live_txid, the
 * id of the transaction that last changed a tracked column. A delta returns
 * every row whose writer the previous snapshot could not see — txid >= its
 * xmax, or in its in-progress list. That is commit-order safe (a long
 * scan-finalize upload that commits after a cursor was issued still lands in
 * the next delta), which a plain sequence is not.
 *
 * Scoping mirrors app/api/handheld/epc-lookup/route.ts: items, bins and
 * locations are tenant-scoped through locations.tenant_id (all locations, every
 * status); custom_skus and matrices are global. locationId only feeds the
 * phone's BIN line — it filters nothing here.
 */

export const LIVE_CATALOG_VERSION = 1;
export const LIVE_CATALOG_DELTA_MAX_ITEMS = 25_000; // more changed items than this → reset
export const LIVE_CATALOG_CURSOR_MAX_AGE_SEC = 7 * 24 * 3600; // older cursor → reset
export const LIVE_CATALOG_TOMBSTONE_RETENTION_DAYS = 14; // must stay > cursor max age

/** A cursor whose in-progress list is longer than this is issued at the
 *  snapshot's xmin instead (empty list): still exact-or-wider, never narrower,
 *  and keeps ?since= well inside URL limits. */
const CURSOR_MAX_XIP = 200;

/** Columnar payload — snapshot and delta share the shape. Every index points
 *  into an array of the SAME payload; -1 = null / not in payload. */
export type LiveCatalogPayload = {
  v: 1;
  kind: "snapshot" | "delta";
  /** Delta only; true → the phone must fetch a snapshot. Tables empty. */
  reset: boolean;
  /** Pass as ?since= on the next delta. */
  cursor: string;
  serverTime: string;
  tenantId: string;
  /** For the phone's BIN display only. */
  locationId: string | null;
  epcCfg: {
    prefixHex: string;
    prefixBits: number;
    assetBits: number;
    serialBits: number;
    assetPaddingDigits: number;
  } | null;
  /** Dictionary for items.status (built from the rows returned). */
  statuses: string[];
  /** Always ALL tenant locations. */
  locations: { id: string[]; code: string[]; name: string[] };
  bins: { id: string[]; code: string[]; loc: number[]; archived: (0 | 1)[] };
  /** name = matrices.description ("" if null). */
  matrices: { id: string[]; name: string[] };
  skus: {
    id: string[];
    systemId: (string | null)[];
    sku: string[];
    color: (string | null)[];
    size: (string | null)[];
    matrix: number[];
    /** Numeric text, e.g. "52.00". */
    retail: (string | null)[];
    assignedBin: number[];
    archived: (0 | 1)[];
  };
  items: { epc: string[]; status: number[]; sku: number[]; bin: number[]; loc: number[] };
  /** Always empty in a snapshot. */
  tombstones: { items: string[]; skus: string[] };
  /** Rows in THIS payload (diagnostics). */
  counts: { items: number; skus: number };
  /** items.status values ghosted on the Statuses page — scanners ignore these
   *  tags (no beep, no count). Older phones ignore this field. */
  ghostStatuses: string[];
};

type ParsedCursor = { issuedAt: number; xmax: string; xip: string[] };

type LocRow = { id: string; code: string | null; name: string | null };
type ItemRow = {
  epc: string;
  status: string;
  sku_id: string | null;
  bin_id: string | null;
  loc_id: string;
};
type SkuRow = {
  id: string;
  system_id: string | null;
  sku: string | null;
  color_code: string | null;
  size: string | null;
  matrix_id: string | null;
  retail_price: string | null;
  assigned_bin_id: string | null;
  archived: boolean | null;
};
type MatrixRow = { id: string; description: string | null };
type BinRow = { id: string; code: string | null; loc_id: string; archived: boolean };
type TombstoneRow = { kind: "item" | "sku"; key: string };
type EpcCfgRow = {
  prefix_hex: string;
  prefix_bits: number;
  asset_bits: number;
  serial_bits: number;
  asset_padding_digits: number;
};

const gzipAsync = promisify(gzip);

/** "xmin:xmax:xip,xip" (txid_current_snapshot()::text) → parts. */
function parseTxidSnapshot(snapText: string): { xmin: string; xmax: string; xip: string[] } {
  const [xmin = "0", xmax = "0", xipRaw = ""] = snapText.trim().split(":");
  const xip = xipRaw.length > 0 ? xipRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { xmin, xmax, xip };
}

/** `v1.<issuedAtUnixSec>.<xmax>.<xip1>-<xip2>-…` (xip part may be empty). */
export function formatLiveCatalogCursor(snapText: string, issuedAt: number): string {
  const snap = parseTxidSnapshot(snapText);
  if (snap.xip.length > CURSOR_MAX_XIP) {
    // Every txid below xmin was already visible, so xmin with no in-progress
    // list over-includes (harmless — upserts/tombstones are idempotent) but
    // never misses a row.
    return `v1.${Math.floor(issuedAt)}.${snap.xmin}.`;
  }
  return `v1.${Math.floor(issuedAt)}.${snap.xmax}.${snap.xip.join("-")}`;
}

const CURSOR_RE = /^v1\.(\d{1,12})\.(\d{1,20})\.((?:\d{1,20})(?:-\d{1,20})*)?$/;

export function parseLiveCatalogCursor(s: string | null | undefined): ParsedCursor | null {
  if (!s || s.length > 8192) return null;
  const m = CURSOR_RE.exec(s.trim());
  if (!m) return null;
  const issuedAt = Number(m[1]);
  if (!Number.isFinite(issuedAt)) return null;
  return {
    issuedAt,
    xmax: m[2]!,
    xip: m[3] ? m[3].split("-") : [],
  };
}

export async function resolveLiveCatalogLocationId(
  pool: Pool,
  req: Request,
  deviceId: string | null,
): Promise<string | null> {
  // Same precedence as scan-finalize: session location first, then the
  // registered device's location.
  const session = await getSessionFromRequest(req);
  const lid = session?.lid?.trim();
  if (lid) return lid;
  const did = deviceId?.trim();
  if (!did) return null;
  return (await resolveEdgeDeviceCached(pool, did))?.locationId ?? null;
}

/** Index lookup for the columnar tables: id → position, -1 when absent. */
function indexer(ids: string[]): (id: string | null | undefined) => number {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, i));
  return (id) => (id == null ? -1 : (m.get(id) ?? -1));
}

function emptyPayload(
  kind: LiveCatalogPayload["kind"],
  base: { cursor: string; serverTime: string; tenantId: string; locationId: string | null },
): LiveCatalogPayload {
  return {
    v: LIVE_CATALOG_VERSION,
    kind,
    reset: false,
    cursor: base.cursor,
    serverTime: base.serverTime,
    tenantId: base.tenantId,
    locationId: base.locationId,
    epcCfg: null,
    statuses: [],
    locations: { id: [], code: [], name: [] },
    bins: { id: [], code: [], loc: [], archived: [] },
    matrices: { id: [], name: [] },
    skus: {
      id: [],
      systemId: [],
      sku: [],
      color: [],
      size: [],
      matrix: [],
      retail: [],
      assignedBin: [],
      archived: [],
    },
    items: { epc: [], status: [], sku: [], bin: [], loc: [] },
    tombstones: { items: [], skus: [] },
    ghostStatuses: [],
    counts: { items: 0, skus: 0 },
  };
}

function fillPayload(
  p: LiveCatalogPayload,
  rows: {
    locations: LocRow[];
    bins: BinRow[];
    matrices: MatrixRow[];
    skus: SkuRow[];
    items: ItemRow[];
    epcCfg: EpcCfgRow | null;
  },
): void {
  for (const r of rows.locations) {
    p.locations.id.push(r.id);
    p.locations.code.push(r.code ?? "");
    p.locations.name.push(r.name ?? "");
  }
  const locIdx = indexer(p.locations.id);

  for (const r of rows.bins) {
    p.bins.id.push(r.id);
    p.bins.code.push(r.code ?? "");
    p.bins.loc.push(locIdx(r.loc_id));
    p.bins.archived.push(r.archived ? 1 : 0);
  }
  const binIdx = indexer(p.bins.id);

  for (const r of rows.matrices) {
    p.matrices.id.push(r.id);
    p.matrices.name.push(r.description ?? "");
  }
  const matrixIdx = indexer(p.matrices.id);

  for (const r of rows.skus) {
    p.skus.id.push(r.id);
    p.skus.systemId.push(r.system_id);
    p.skus.sku.push(r.sku ?? "");
    p.skus.color.push(r.color_code);
    p.skus.size.push(r.size);
    p.skus.matrix.push(matrixIdx(r.matrix_id));
    p.skus.retail.push(r.retail_price);
    p.skus.assignedBin.push(binIdx(r.assigned_bin_id));
    p.skus.archived.push(r.archived ? 1 : 0);
  }
  const skuIdx = indexer(p.skus.id);

  const statusIdx = new Map<string, number>();
  for (const r of rows.items) {
    let s = statusIdx.get(r.status);
    if (s === undefined) {
      s = p.statuses.length;
      p.statuses.push(r.status);
      statusIdx.set(r.status, s);
    }
    p.items.epc.push(r.epc.toUpperCase());
    p.items.status.push(s);
    p.items.sku.push(skuIdx(r.sku_id));
    p.items.bin.push(binIdx(r.bin_id));
    p.items.loc.push(locIdx(r.loc_id));
  }

  p.epcCfg = rows.epcCfg
    ? {
        prefixHex: rows.epcCfg.prefix_hex,
        prefixBits: rows.epcCfg.prefix_bits,
        assetBits: rows.epcCfg.asset_bits,
        serialBits: rows.epcCfg.serial_bits,
        assetPaddingDigits: rows.epcCfg.asset_padding_digits,
      }
    : null;
  p.counts = { items: p.items.epc.length, skus: p.skus.id.length };
}

/**
 * Runs `fn` in one pooled client inside a REPEATABLE READ READ ONLY
 * transaction. The snapshot SELECT is the first statement, which fixes the
 * snapshot every later SELECT in `fn` sees — so the cursor and the rows agree.
 */
async function withCatalogSnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient, snap: { snapText: string; serverTime: Date }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const s = await client.query<{ snap: string; server_time: Date }>(
      `SELECT txid_current_snapshot()::text AS snap, now() AS server_time`,
    );
    const out = await fn(client, {
      snapText: s.rows[0]!.snap,
      serverTime: s.rows[0]!.server_time,
    });
    await client.query("COMMIT");
    return out;
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

async function queryLocations(client: PoolClient, tenantId: string): Promise<LocRow[]> {
  const r = await client.query<LocRow>(
    `SELECT id::text AS id, code, name
       FROM locations
      WHERE tenant_id = $1::uuid
      ORDER BY code`,
    [tenantId],
  );
  return r.rows;
}

async function queryEpcCfg(client: PoolClient, tenantId: string): Promise<EpcCfgRow | null> {
  const r = await client.query<EpcCfgRow>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config WHERE tenant_id = $1::uuid LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

const ITEM_COLS = `i.epc, i.status, i.custom_sku_id::text AS sku_id, i.bin_id::text AS bin_id,
                   i.location_id::text AS loc_id`;
const SKU_COLS = `cs.id::text AS id, cs.ls_system_id::text AS system_id, cs.sku, cs.color_code,
                  cs.size, cs.matrix_id::text AS matrix_id, cs.retail_price::text AS retail_price,
                  cs.assigned_bin_id::text AS assigned_bin_id, cs.archived`;
const BIN_COLS = `b.id::text AS id, b.code, b.location_id::text AS loc_id,
                  (b.archived_at IS NOT NULL) AS archived`;

export async function buildLiveCatalogSnapshot(
  pool: Pool,
  args: { tenantId: string; locationId: string | null },
): Promise<LiveCatalogPayload> {
  const t0 = Date.now();
  const payload = await withCatalogSnapshot(pool, async (client, snap) => {
    const locations = await queryLocations(client, args.tenantId);
    const items = await client.query<ItemRow>(
      `SELECT ${ITEM_COLS}
         FROM items i
         JOIN locations l ON l.id = i.location_id
        WHERE l.tenant_id = $1::uuid
        ORDER BY i.epc`,
      [args.tenantId],
    );
    const skus = await client.query<SkuRow>(`SELECT ${SKU_COLS} FROM custom_skus cs`);
    const matrices = await client.query<MatrixRow>(
      `SELECT m.id::text AS id, m.description FROM matrices m`,
    );
    const bins = await client.query<BinRow>(
      `SELECT ${BIN_COLS}
         FROM bins b
         JOIN locations l ON l.id = b.location_id
        WHERE l.tenant_id = $1::uuid`,
      [args.tenantId],
    );
    const epcCfg = await queryEpcCfg(client, args.tenantId);

    const p = emptyPayload("snapshot", {
      cursor: formatLiveCatalogCursor(snap.snapText, snap.serverTime.getTime() / 1000),
      serverTime: snap.serverTime.toISOString(),
      tenantId: args.tenantId,
      locationId: args.locationId,
    });
    fillPayload(p, {
      locations,
      bins: bins.rows,
      matrices: matrices.rows,
      skus: skus.rows,
      items: items.rows,
      epcCfg,
    });
    p.ghostStatuses = await loadGhostWmsStatuses(client);
    return p;
  });
  console.info("[live-catalog] snapshot", {
    tenantId: args.tenantId,
    items: payload.counts.items,
    skus: payload.counts.skus,
    ms: Date.now() - t0,
  });
  return payload;
}

/** Distinct non-null values. */
function uniq(values: Iterable<string | null>): string[] {
  const s = new Set<string>();
  for (const v of values) if (v) s.add(v);
  return [...s];
}

export async function buildLiveCatalogDelta(
  pool: Pool,
  args: { tenantId: string; locationId: string | null; since: string | null },
): Promise<LiveCatalogPayload> {
  const incoming = parseLiveCatalogCursor(args.since);

  const payload = await withCatalogSnapshot(pool, async (client, snap) => {
    const nowSec = snap.serverTime.getTime() / 1000;
    const base = {
      cursor: formatLiveCatalogCursor(snap.snapText, nowSec),
      serverTime: snap.serverTime.toISOString(),
      tenantId: args.tenantId,
      locationId: args.locationId,
    };
    const reset = (reason: string): LiveCatalogPayload => {
      console.info("[live-catalog] delta reset", { reason });
      return { ...emptyPayload("delta", base), reset: true };
    };

    if (!incoming) return reset(args.since ? "bad_cursor" : "no_cursor");
    if (nowSec - incoming.issuedAt > LIVE_CATALOG_CURSOR_MAX_AGE_SEC) {
      return reset("cursor_expired");
    }
    // A cursor from the future means the DB was restored / rewound: txids it
    // treats as "already seen" may now belong to different writes.
    if (BigInt(incoming.xmax) > BigInt(parseTxidSnapshot(snap.snapText).xmax)) {
      return reset("cursor_ahead_of_db");
    }

    const changed = (alias: string) =>
      `(${alias}.live_txid >= $1::bigint OR ${alias}.live_txid = ANY($2::bigint[]))`;
    const cx = [incoming.xmax, incoming.xip];

    // A tenant-wide reset (RFID zero-out deletes with triggers disabled, so it
    // leaves no per-EPC tombstones) — the phone must re-download everything.
    const tenantReset = await client.query(
      `SELECT 1 FROM live_catalog_tombstones t
        WHERE t.tenant_id = $3::uuid AND t.kind = 'reset' AND ${changed("t")}
        LIMIT 1`,
      [...cx, args.tenantId],
    );
    if ((tenantReset.rowCount ?? 0) > 0) return reset("tenant_reset");

    // No ORDER BY here: with LIMIT it could tempt the planner into walking the
    // epc index instead of the live_txid range. Deltas are small; order is moot.
    const items = await client.query<ItemRow>(
      `SELECT ${ITEM_COLS}
         FROM items i
         JOIN locations l ON l.id = i.location_id
        WHERE l.tenant_id = $3::uuid AND ${changed("i")}
        LIMIT ${LIVE_CATALOG_DELTA_MAX_ITEMS + 1}`,
      [...cx, args.tenantId],
    );
    if (items.rows.length > LIVE_CATALOG_DELTA_MAX_ITEMS) return reset("too_many_items");

    // Changed SKUs plus every SKU the returned items reference (full rows), so
    // the phone never resolves an index outside this payload.
    const skus = await client.query<SkuRow>(
      `SELECT ${SKU_COLS}
         FROM custom_skus cs
        WHERE ${changed("cs")} OR cs.id = ANY($3::uuid[])`,
      [...cx, uniq(items.rows.map((r) => r.sku_id))],
    );
    const matrices = await client.query<MatrixRow>(
      `SELECT m.id::text AS id, m.description
         FROM matrices m
        WHERE ${changed("m")} OR m.id = ANY($3::uuid[])`,
      [...cx, uniq(skus.rows.map((r) => r.matrix_id))],
    );
    const bins = await client.query<BinRow>(
      `SELECT ${BIN_COLS}
         FROM bins b
         JOIN locations l ON l.id = b.location_id
        WHERE l.tenant_id = $3::uuid
          AND (${changed("b")} OR b.id = ANY($4::uuid[]))`,
      [
        ...cx,
        args.tenantId,
        uniq([
          ...items.rows.map((r) => r.bin_id),
          ...skus.rows.map((r) => r.assigned_bin_id),
        ]),
      ],
    );
    // NOT EXISTS keeps tombstones and upserts disjoint (delete-then-reinsert of
    // an EPC inside one window can't kill it on the phone), so the phone may
    // apply them in any order.
    const tombstones = await client.query<TombstoneRow>(
      `SELECT t.kind, t.key
         FROM live_catalog_tombstones t
        WHERE (t.tenant_id = $3::uuid OR t.tenant_id IS NULL) AND ${changed("t")}
          AND t.kind IN ('item', 'sku')
          AND NOT (t.kind = 'item' AND EXISTS (SELECT 1 FROM items i WHERE i.epc = t.key))
          AND NOT (t.kind = 'sku'  AND EXISTS (SELECT 1 FROM custom_skus cs WHERE cs.id::text = t.key))`,
      [...cx, args.tenantId],
    );
    const locations = await queryLocations(client, args.tenantId);
    const epcCfg = await queryEpcCfg(client, args.tenantId);

    const p = emptyPayload("delta", base);
    fillPayload(p, {
      locations,
      bins: bins.rows,
      matrices: matrices.rows,
      skus: skus.rows,
      items: items.rows,
      epcCfg,
    });
    // The same key can be tombstoned more than once inside a window.
    const deadItems = new Set<string>();
    const deadSkus = new Set<string>();
    for (const t of tombstones.rows) {
      if (t.kind === "item") deadItems.add(t.key.toUpperCase());
      else deadSkus.add(t.key);
    }
    p.tombstones = { items: [...deadItems], skus: [...deadSkus] };
    p.ghostStatuses = await loadGhostWmsStatuses(client);
    return p;
  });

  maybePruneLiveCatalogTombstones(pool);
  return payload;
}

/**
 * JSON response, gzipped when the client accepts it (the handheld always
 * does). Async gzip — a multi-MB snapshot must not block the event loop.
 * Same header set as app/api/handheld/scan-sources/[id]/epcs/route.ts.
 */
export async function liveCatalogJsonResponse(
  req: Request,
  payload: LiveCatalogPayload,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
  if (acceptsGzip && body.length > 1024) {
    const gzipped = await gzipAsync(body);
    return new Response(gzipped, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Cache-Control": "no-store",
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

let lastTombstonePruneAt = 0;

/** Fire-and-forget, at most once per hour per process. */
export function maybePruneLiveCatalogTombstones(pool: Pool): void {
  const now = Date.now();
  if (now - lastTombstonePruneAt < 3_600_000) return;
  lastTombstonePruneAt = now;
  pool
    .query(
      `DELETE FROM live_catalog_tombstones
        WHERE deleted_at < now() - ($1::int * interval '1 day')`,
      [LIVE_CATALOG_TOMBSTONE_RETENTION_DAYS],
    )
    .catch((e: unknown) => {
      console.warn("[live-catalog] tombstone prune failed", e);
    });
}
