/**
 * CarbonGradingAI — the WMS side of the phone app.
 *
 * The phone measures; everything else lives here so the desktop and the app
 * always agree: finding the item from the hang tag, writing a reading to every
 * colour (and every product of its cut group), the size check across a cut,
 * the measuring queue, the review list, and the photo copies in R2 and in the
 * owner's Dropbox folder.
 */
import type { Pool } from "pg";
import {
  GRADING_PROFILES,
  PROFILE_BY_ID,
  pairMismatches,
  profileForProduct,
  sizeRank,
  type GradingProfile,
  type GradingProfileId,
} from "@/lib/size-grading/grading-app-profiles";
import { downloadStorageObject, isR2StorageConfigured, uploadBytesToStorage } from "@/lib/storageProvider";
import { dropboxSafe, dropboxUpload, gradingDropboxRoot, isDropboxConfigured } from "@/lib/server/dropbox-upload";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normSize = (s: string | null | undefined) => String(s ?? "").trim().toUpperCase();

/* ─────────────────────────────── lookup ─────────────────────────────── */

export type ItemInfo = {
  matrixId: string;
  name: string | null;
  upc: string | null;
  vendor: string | null;
  category: string | null;
  subcategory: string | null;
  fabric: string | null;
  care: string | null;
  image: string | null;
  shopifyProductId: string | null;
};

export type SizeRow = {
  customSkuId: string;
  sku: string;
  size: string | null;
  color: string | null;
  upc: string | null;
  lastMeasuredAt: string | null;
};

export type CutGroupInfo = { id: string; name: string; profile: string | null; products: number } | null;

export type LookupResult = {
  item: ItemInfo;
  profile: { id: GradingProfileId | null; why: string; measurable: boolean };
  cutGroup: CutGroupInfo;
  sizes: SizeRow[];
  /** The exact SKU the code named, when it names one. */
  picked: string | null;
  /** When the code fits several sizes (old hang tags drop the size letters): the ones it fits. */
  candidates: string[];
};

async function itemInfo(pool: Pool, matrixId: string): Promise<ItemInfo | null> {
  const r = await pool.query<{
    id: string; description: string | null; upc: string | null; vendor: string | null; category: string | null;
    subcategory_1: string | null; fabric_composition: string | null; care_instructions: string | null;
    shopify_featured_image_url: string | null; shopify_product_id: string | null;
  }>(
    `SELECT id, description, upc, vendor, category, subcategory_1, fabric_composition, care_instructions,
            shopify_featured_image_url, shopify_product_id
       FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const m = r.rows[0];
  if (!m) return null;
  return {
    matrixId: m.id, name: m.description, upc: m.upc, vendor: m.vendor, category: m.category,
    subcategory: m.subcategory_1, fabric: m.fabric_composition, care: m.care_instructions,
    image: m.shopify_featured_image_url, shopifyProductId: m.shopify_product_id,
  };
}

export async function cutGroupFor(pool: Pool, matrixId: string): Promise<CutGroupInfo> {
  const r = await pool.query<{ id: string; name: string; profile: string | null; products: string }>(
    `SELECT g.id, g.name, g.profile,
            (SELECT count(*) FROM size_grading_cut_group_members x WHERE x.cut_group_id = g.id) AS products
       FROM size_grading_cut_group_members mm
       JOIN size_grading_cut_groups g ON g.id = mm.cut_group_id
      WHERE mm.matrix_id = $1::uuid`,
    [matrixId],
  );
  const g = r.rows[0];
  return g ? { id: g.id, name: g.name, profile: g.profile, products: Number(g.products) } : null;
}

async function sizesOf(pool: Pool, matrixId: string): Promise<SizeRow[]> {
  const r = await pool.query<{
    id: string; sku: string; size: string | null; color_code: string | null; upc: string | null; last: string | null;
  }>(
    `SELECT cs.id, cs.sku, cs.size, cs.color_code, cs.upc,
            (SELECT max(measured_at) FROM size_grading_measurements g WHERE g.custom_sku_id = cs.id) AS last
       FROM custom_skus cs
      WHERE cs.matrix_id = $1::uuid AND cs.archived = false
      ORDER BY cs.sort_order NULLS LAST, cs.size, cs.sku`,
    [matrixId],
  );
  return r.rows
    .map((s) => ({ customSkuId: s.id, sku: s.sku, size: s.size, color: s.color_code, upc: s.upc, lastMeasuredAt: s.last }))
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || String(a.color).localeCompare(String(b.color)));
}

/**
 * A scanned code → the item. Current hang tags carry the full custom SKU (Code
 * 93, letters included); older ones carry it with the trailing size letters
 * replaced by "1" (lib/utils/zpl-carbon-tag.ts), which names the colour but
 * not the size — the phone then asks which size is in hand. A UPC names only
 * the product.
 */
export async function lookupCode(pool: Pool, raw: string): Promise<LookupResult | null> {
  const code = raw.trim().toUpperCase();
  if (!code) return null;
  let matrixId: string | null = null;
  let picked: string | null = null;
  let candidates: string[] = [];

  const exact = await pool.query<{ id: string; matrix_id: string }>(
    `SELECT id, matrix_id FROM custom_skus WHERE upper(sku) = $1 AND archived = false LIMIT 1`,
    [code],
  );
  if (exact.rows[0]) {
    matrixId = exact.rows[0].matrix_id;
    picked = exact.rows[0].id;
  } else if (/1$/.test(code)) {
    const stripped = await pool.query<{ id: string; matrix_id: string }>(
      `SELECT id, matrix_id FROM custom_skus
        WHERE archived = false AND upper(regexp_replace(sku, '[A-Za-z]+$', '1')) = $1`,
      [code],
    );
    if (stripped.rows.length) {
      matrixId = stripped.rows[0].matrix_id;
      candidates = stripped.rows.filter((r) => r.matrix_id === matrixId).map((r) => r.id);
      if (candidates.length === 1) { picked = candidates[0]; candidates = []; }
    }
  }
  if (!matrixId) {
    const byUpc = await pool.query<{ id: string }>(
      `SELECT m.id FROM matrices m
        WHERE m.upc = $1
           OR EXISTS (SELECT 1 FROM custom_skus cs WHERE cs.matrix_id = m.id AND cs.archived = false AND cs.upc = $1)
        ORDER BY (m.upc = $1) DESC, (m.shopify_product_id IS NOT NULL) DESC
        LIMIT 1`,
      [code],
    );
    matrixId = byUpc.rows[0]?.id ?? null;
  }
  if (!matrixId) return null;
  return describeMatrix(pool, matrixId, picked, candidates);
}

export async function describeMatrix(pool: Pool, matrixId: string, picked: string | null = null, candidates: string[] = []): Promise<LookupResult | null> {
  const item = await itemInfo(pool, matrixId);
  if (!item) return null;
  const [cutGroup, sizes] = await Promise.all([cutGroupFor(pool, matrixId), sizesOf(pool, matrixId)]);
  const guess = profileForProduct(item.category, item.subcategory, item.name);
  /* A cut group with its own type wins over the catalogue words: the owner set it. */
  const groupProfile = cutGroup?.profile && PROFILE_BY_ID[cutGroup.profile as GradingProfileId] ? (cutGroup.profile as GradingProfileId) : null;
  const profile = groupProfile
    ? { id: groupProfile, why: `cut group "${cutGroup!.name}"`, measurable: true }
    : guess.kind === "profile"
    ? { id: guess.profile, why: guess.why, measurable: true }
    : { id: null, why: guess.why, measurable: guess.kind !== "not-measured" };
  return { item, profile, cutGroup, sizes, picked, candidates };
}

/* ──────────────────────────────── save ──────────────────────────────── */

export type ScanLine = { pts: [number, number][]; source: "outline" | "ai" | "manual"; moved?: boolean };

export type ScanMeta = {
  id: string;
  customSkuId: string;
  profile: GradingProfileId;
  view?: "front" | "back";
  pointsCm: Record<string, number>;
  lines: Record<string, ScanLine>;
  aiLines?: Record<string, unknown> | null;
  outlineLines?: Record<string, unknown> | null;
  pxPerCm: number;
  photoW?: number;
  photoH?: number;
  depth?: Record<string, unknown> | null;
  device?: Record<string, unknown> | null;
  appVersion?: string;
  aiModel?: string | null;
  aiCostUsd?: number | null;
  capturedAt?: string | null;
  /** Flags raised on the phone (test phone, label size mismatch, AI vs outline). */
  flags?: string[];
};

export type SizeCheckRow = {
  key: string;
  label: string;
  fromSize: string;
  toSize: string;
  deltaCm: number;
  status: "normal" | "flag";
  note?: string;
};

export type SaveResult = {
  ok: true;
  scanId: string;
  duplicate: boolean;
  size: string | null;
  appliedTo: { sameProduct: number; cutGroup: { id: string; name: string; products: number; skus: number } | null; total: number };
  colors: string[];
  sizeCheck: SizeCheckRow[];
  flags: string[];
  status: string;
  dropbox: "queued" | "off";
};

async function previousResult(pool: Pool, id: string): Promise<SaveResult | null> {
  const r = await pool.query<{ size: string | null; applied_to: number; flags: string[]; status: string; cut_group_id: string | null }>(
    `SELECT size, applied_to, flags, status, cut_group_id FROM size_grading_scans WHERE id = $1::uuid`,
    [id],
  );
  const s = r.rows[0];
  if (!s) return null;
  return {
    ok: true, scanId: id, duplicate: true, size: s.size,
    appliedTo: { sameProduct: 0, cutGroup: null, total: s.applied_to },
    colors: [], sizeCheck: [], flags: s.flags ?? [], status: s.status, dropbox: isDropboxConfigured() ? "queued" : "off",
  };
}

export async function saveScan(pool: Pool, userId: string | null, meta: ScanMeta, photo: Buffer | null): Promise<SaveResult> {
  /* The phone makes the scan id, so a save retried from its offline queue
     after the first attempt actually landed is recognised, not doubled. */
  const prior = await previousResult(pool, meta.id);
  if (prior) return prior;

  const profile = PROFILE_BY_ID[meta.profile];
  if (!profile) throw new Error(`Unknown garment type "${meta.profile}"`);
  const sku = await pool.query<{ id: string; matrix_id: string; size: string | null }>(
    `SELECT id, matrix_id, size FROM custom_skus WHERE id = $1::uuid AND archived = false`,
    [meta.customSkuId],
  );
  const picked = sku.rows[0];
  if (!picked) throw new Error("That size no longer exists in the WMS.");
  const cut = await cutGroupFor(pool, picked.matrix_id);

  /* Same product, every colour of this size; plus every product of the cut
     group in the same size — a cut is one pattern, the owner grouped it. A
     SKU without a size is only ever itself. */
  const same = await pool.query<{ id: string; color_code: string | null }>(
    picked.size === null
      ? `SELECT id, color_code FROM custom_skus WHERE id = $1::uuid`
      : `SELECT id, color_code FROM custom_skus
          WHERE matrix_id = $1::uuid AND archived = false AND upper(trim(size)) = $2`,
    picked.size === null ? [picked.id] : [picked.matrix_id, normSize(picked.size)],
  );
  let groupRows: { id: string; matrix_id: string }[] = [];
  if (cut && picked.size !== null) {
    const g = await pool.query<{ id: string; matrix_id: string }>(
      `SELECT cs.id, cs.matrix_id FROM custom_skus cs
         JOIN size_grading_cut_group_members mm ON mm.matrix_id = cs.matrix_id
        WHERE mm.cut_group_id = $1::uuid AND cs.matrix_id <> $2::uuid
          AND cs.archived = false AND upper(trim(cs.size)) = $3`,
      [cut.id, picked.matrix_id, normSize(picked.size)],
    );
    groupRows = g.rows;
  }
  const targets = [...new Set([...same.rows.map((r) => r.id), ...groupRows.map((r) => r.id)])];

  const flags = [...new Set([...(meta.flags ?? []), ...pairMismatches(profile, meta.pointsCm)])];
  const check = await sizeCheck(pool, picked.matrix_id, cut?.id ?? null, picked.size, meta.pointsCm, profile);
  for (const c of check) if (c.status === "flag") flags.push(`size check: ${c.label} ${c.fromSize}→${c.toSize} ${c.deltaCm > 0 ? "+" : ""}${c.deltaCm.toFixed(1)} cm`);
  const testPhone = flags.some((f) => f.startsWith("test phone"));
  const status = flags.length ? "flagged" : "saved";

  /* Photo first: a scan row must never point at a photo that was not stored. */
  let photoKey: string | null = null;
  if (photo && photo.length && isR2StorageConfigured()) {
    const d = new Date();
    photoKey = `grading-scans/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${meta.id}.jpg`;
    await uploadBytesToStorage({ path: photoKey, bytes: new Uint8Array(photo), contentType: "image/jpeg" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO size_grading_scans
         (id, custom_sku_id, matrix_id, cut_group_id, profile, garment_type, view, size, points_cm, lines,
          ai_lines, outline_lines, px_per_cm, photo_w, photo_h, photo_key, depth, device, app_version,
          ai_model, ai_cost_usd, status, flags, applied_to, captured_at, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
               $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19,
               $20, $21, $22, $23::jsonb, $24, $25, $26)`,
      [
        meta.id, picked.id, picked.matrix_id, cut?.id ?? null, profile.id, profile.family, meta.view ?? "front",
        picked.size, JSON.stringify(meta.pointsCm), JSON.stringify(meta.lines),
        meta.aiLines ? JSON.stringify(meta.aiLines) : null, meta.outlineLines ? JSON.stringify(meta.outlineLines) : null,
        meta.pxPerCm, meta.photoW ?? null, meta.photoH ?? null, photoKey,
        meta.depth ? JSON.stringify(meta.depth) : null, meta.device ? JSON.stringify(meta.device) : null,
        meta.appVersion ?? null, meta.aiModel ?? null, meta.aiCostUsd ?? null, status, JSON.stringify(flags),
        testPhone ? 0 : targets.length, meta.capturedAt ?? null, userId,
      ],
    );
    /* A phone without a depth sensor (test mode) never writes the item's
       numbers: its scale is a guess, and a guess must not reach the size guide. */
    if (!testPhone && targets.length) {
      await client.query(
        `INSERT INTO size_grading_measurements
           (custom_sku_id, garment_type, points_cm, px_per_cm, type_overridden, measured_by, note, view, source, scan_id)
         SELECT unnest($1::uuid[]), $2, $3::jsonb, $4, false, $5, $6, $7, 'app', $8::uuid`,
        [targets, profile.family, JSON.stringify(meta.pointsCm), meta.pxPerCm, userId, `CarbonGradingAI · ${profile.label}`, meta.view ?? "front", meta.id],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const dropboxOn = isDropboxConfigured() && Boolean(photo?.length);
  if (dropboxOn) void copyToDropbox(pool, meta.id, photo!).then(() => retryDropbox(pool)).catch(() => {});

  const groupMatrices = new Set(groupRows.map((r) => r.matrix_id));
  return {
    ok: true,
    scanId: meta.id,
    duplicate: false,
    size: picked.size,
    appliedTo: {
      sameProduct: testPhone ? 0 : same.rows.length,
      cutGroup: cut ? { id: cut.id, name: cut.name, products: groupMatrices.size + 1, skus: testPhone ? 0 : groupRows.length } : null,
      total: testPhone ? 0 : targets.length,
    },
    colors: same.rows.map((r) => r.color_code).filter((c): c is string => Boolean(c)),
    sizeCheck: check,
    flags,
    status,
    dropbox: dropboxOn ? "queued" : "off",
  };
}

/* ───────────────────────────── Dropbox copy ───────────────────────────── */

async function copyToDropbox(pool: Pool, scanId: string, photo: Buffer): Promise<void> {
  const r = await pool.query<{
    name: string | null; upc: string | null; size: string | null; color: string | null; created_at: Date;
    points_cm: Record<string, number>; profile: string; lines: unknown; px_per_cm: string; depth: unknown; flags: unknown;
  }>(
    `SELECT m.description AS name, m.upc, s.size, cs.color_code AS color, s.created_at, s.points_cm, s.profile,
            s.lines, s.px_per_cm, s.depth, s.flags
       FROM size_grading_scans s
       JOIN matrices m ON m.id = s.matrix_id
       JOIN custom_skus cs ON cs.id = s.custom_sku_id
      WHERE s.id = $1::uuid`,
    [scanId],
  );
  const s = r.rows[0];
  if (!s) return;
  /* One folder per product, named so the owner can find it by eye. Time in
     Orlando, which is how every other download in the WMS is named. */
  const when = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(s.created_at).replace(/[^0-9]+/g, "-").replace(/-+$/, "");
  const folder = `${gradingDropboxRoot()}/${dropboxSafe(`${s.name ?? "Item"} (${s.upc ?? "no UPC"})`)}`;
  const base = dropboxSafe(`${s.size ?? "nosize"} ${s.color ?? ""} ${when} ${scanId.slice(0, 8)}`).replace(/ /g, "_");
  try {
    const path = await dropboxUpload(`${folder}/${base}.jpg`, photo);
    const sidecar = {
      scanId, product: s.name, upc: s.upc, size: s.size, colour: s.color, profile: s.profile,
      pxPerCm: Number(s.px_per_cm), measurementsCm: s.points_cm, lines: s.lines, depth: s.depth, flags: s.flags,
      savedAt: s.created_at.toISOString(),
    };
    await dropboxUpload(`${folder}/${base}.json`, Buffer.from(JSON.stringify(sidecar, null, 2)));
    await pool.query(`UPDATE size_grading_scans SET dropbox_path = $2, dropbox_error = NULL WHERE id = $1::uuid`, [scanId, path]);
  } catch (e) {
    await pool.query(`UPDATE size_grading_scans SET dropbox_error = $2 WHERE id = $1::uuid`, [scanId, (e instanceof Error ? e.message : String(e)).slice(0, 500)]);
  }
}

/** Copies that failed earlier (Dropbox down, token refresh) — a few per save, from R2. */
async function retryDropbox(pool: Pool): Promise<void> {
  const r = await pool.query<{ id: string; photo_key: string }>(
    `SELECT id, photo_key FROM size_grading_scans
      WHERE dropbox_path IS NULL AND dropbox_error IS NOT NULL AND photo_key IS NOT NULL
        AND created_at > now() - interval '14 days'
      ORDER BY created_at LIMIT 3`,
  );
  for (const row of r.rows) {
    try {
      const obj = await downloadStorageObject(row.photo_key);
      await copyToDropbox(pool, row.id, Buffer.from(obj.body));
    } catch { /* stays queued */ }
  }
}

/* ───────────────────────────── size check ───────────────────────────── */

const PLAIN_KEYS = new Set(["chest", "waist", "hip", "length", "hem", "shoulder", "sleeve", "cuff", "strap", "rise", "thigh", "knee", "inseam", "outseam", "legOpening", "sideLength"]);

function labelFor(profile: GradingProfile, key: string): string {
  const own = profile.points.find((p) => p.key === key);
  if (own) return own.label;
  const pair = profile.points.find((p) => p.pairOf === key);
  return pair ? pair.label.replace(/ [LR]$/, "") : key;
}

/**
 * Does this size sit between its neighbours? Compares the new reading with the
 * latest front reading of the next size down and up in the same cut (or the
 * same product when it has no cut): an XXL narrower than the XL, or a jump of
 * twice the cut's usual step, is a mis-scan until shown otherwise.
 */
export async function sizeCheck(
  pool: Pool, matrixId: string, cutGroupId: string | null, size: string | null,
  pointsCm: Record<string, number>, profile: GradingProfile,
): Promise<SizeCheckRow[]> {
  if (!size) return [];
  const matrices = cutGroupId
    ? (await pool.query<{ matrix_id: string }>(`SELECT matrix_id FROM size_grading_cut_group_members WHERE cut_group_id = $1::uuid`, [cutGroupId])).rows.map((r) => r.matrix_id)
    : [matrixId];
  if (!matrices.includes(matrixId)) matrices.push(matrixId);
  const r = await pool.query<{ size: string; points_cm: Record<string, number> }>(
    `SELECT DISTINCT ON (upper(trim(cs.size))) cs.size, g.points_cm
       FROM size_grading_measurements g
       JOIN custom_skus cs ON cs.id = g.custom_sku_id
      WHERE cs.matrix_id = ANY($1::uuid[]) AND g.view = 'front' AND cs.size IS NOT NULL
        AND upper(trim(cs.size)) <> $2
      ORDER BY upper(trim(cs.size)), g.measured_at DESC`,
    [matrices, normSize(size)],
  );
  const ladder = [...r.rows.map((x) => ({ size: x.size, cm: x.points_cm })), { size, cm: pointsCm }]
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
  const at = ladder.findIndex((x) => x.size === size && x.cm === pointsCm);
  const out: SizeCheckRow[] = [];
  for (const key of Object.keys(pointsCm)) {
    if (!PLAIN_KEYS.has(key)) continue;
    const series = ladder.map((x) => x.cm[key]);
    /* The cut's usual step for this point, from the other neighbouring pairs. */
    const steps: number[] = [];
    for (let i = 1; i < ladder.length; i++) {
      if (i === at || i - 1 === at) continue;
      if (typeof series[i] === "number" && typeof series[i - 1] === "number") steps.push(series[i]! - series[i - 1]!);
    }
    steps.sort((a, b) => a - b);
    const usual = steps.length ? steps[steps.length >> 1] : null;
    const judge = (lo: number, hi: number, fromSize: string, toSize: string) => {
      const d = hi - lo;
      let status: "normal" | "flag" = "normal";
      let note: string | undefined;
      if (d < -0.5) { status = "flag"; note = `${toSize} is smaller than ${fromSize}`; }
      else if (usual !== null && Math.abs(d) > Math.max(3, Math.abs(usual) * 2.5)) { status = "flag"; note = `step is far from the usual ${usual.toFixed(1)} cm`; }
      else if (usual === null && Math.abs(d) > 8) { status = "flag"; note = "unusually large step"; }
      out.push({ key, label: labelFor(profile, key), fromSize, toSize, deltaCm: Math.round(d * 10) / 10, status, note });
    };
    const prev = ladder.slice(0, at).reverse().find((x) => typeof x.cm[key] === "number");
    const next = ladder.slice(at + 1).find((x) => typeof x.cm[key] === "number");
    if (prev) judge(prev.cm[key], pointsCm[key], prev.size, size);
    if (next) judge(pointsCm[key], next.cm[key], size, next.size);
  }
  return out;
}

/* ─────────────────────────────── queue ─────────────────────────────── */

export type QueueEntry = {
  kind: "cut" | "product";
  cutGroupId: string | null;
  name: string;
  size: string;
  products: number;
  profile: GradingProfileId | null;
  /** A product to pick off the rail for it. */
  matrixId: string;
  sampleSku: string | null;
};

export type QueueResult = {
  progress: { measured: number; total: number };
  entries: QueueEntry[];
  needsCheck: { scanId: string; name: string | null; size: string | null; flags: string[]; createdAt: string }[];
  groups: number;
};

/**
 * What to measure next. A "size" is a product's size label (all colours are
 * one reading). Products count only when they are on Shopify, have live SKUs
 * and are a garment the app can measure.
 */
export async function buildQueue(pool: Pool, limit = 60): Promise<QueueResult> {
  const rows = await pool.query<{
    matrix_id: string; name: string | null; category: string | null; subcategory_1: string | null;
    size: string; measured: boolean; sku: string; cut_group_id: string | null; group_name: string | null; group_profile: string | null;
  }>(
    `SELECT m.id AS matrix_id, m.description AS name, m.category, m.subcategory_1,
            upper(trim(cs.size)) AS size,
            bool_or(EXISTS (SELECT 1 FROM size_grading_measurements g WHERE g.custom_sku_id = cs.id)) AS measured,
            min(cs.sku) AS sku,
            mm.cut_group_id, cg.name AS group_name, cg.profile AS group_profile
       FROM matrices m
       JOIN custom_skus cs ON cs.matrix_id = m.id AND cs.archived = false AND cs.size IS NOT NULL AND trim(cs.size) <> ''
       LEFT JOIN size_grading_cut_group_members mm ON mm.matrix_id = m.id
       LEFT JOIN size_grading_cut_groups cg ON cg.id = mm.cut_group_id
      WHERE m.shopify_product_id IS NOT NULL
      GROUP BY m.id, m.description, m.category, m.subcategory_1, upper(trim(cs.size)), mm.cut_group_id, cg.name, cg.profile`,
  );
  let measured = 0, total = 0;
  const groups = new Map<string, { name: string; profile: string | null; sizes: Map<string, { measured: boolean; matrices: Set<string>; sample: { matrixId: string; sku: string } }> }>();
  const loose: QueueEntry[] = [];
  const looseCount = new Map<string, number>();
  for (const r of rows.rows) {
    const guess = profileForProduct(r.category, r.subcategory_1, r.name);
    if (guess.kind === "not-measured") continue;
    total++;
    if (r.measured) measured++;
    if (r.cut_group_id) {
      const g = groups.get(r.cut_group_id) ?? { name: r.group_name ?? "Cut", profile: r.group_profile, sizes: new Map() };
      const s = g.sizes.get(r.size) ?? { measured: false, matrices: new Set<string>(), sample: { matrixId: r.matrix_id, sku: r.sku } };
      s.measured = s.measured || r.measured;
      s.matrices.add(r.matrix_id);
      g.sizes.set(r.size, s);
      groups.set(r.cut_group_id, g);
    } else if (!r.measured) {
      looseCount.set(r.matrix_id, (looseCount.get(r.matrix_id) ?? 0) + 1);
      loose.push({
        kind: "product", cutGroupId: null, name: r.name ?? "Item", size: r.size, products: 1,
        profile: guess.kind === "profile" ? guess.profile : null, matrixId: r.matrix_id, sampleSku: r.sku,
      });
    }
  }
  /* Measuring a whole cut group is the fastest progress (one garment covers
     every product in it), so cut entries come first, biggest first. */
  const cutEntries: QueueEntry[] = [];
  for (const [id, g] of groups) {
    for (const [size, s] of g.sizes) {
      if (s.measured) continue;
      cutEntries.push({
        kind: "cut", cutGroupId: id, name: g.name, size, products: s.matrices.size,
        profile: (g.profile as GradingProfileId) ?? null, matrixId: s.sample.matrixId, sampleSku: s.sample.sku,
      });
    }
  }
  cutEntries.sort((a, b) => b.products - a.products || a.name.localeCompare(b.name) || sizeRank(a.size) - sizeRank(b.size));
  loose.sort((a, b) => a.name.localeCompare(b.name) || sizeRank(a.size) - sizeRank(b.size));

  const flagged = await pool.query<{ id: string; name: string | null; size: string | null; flags: string[]; created_at: string }>(
    `SELECT s.id, m.description AS name, s.size, s.flags, s.created_at
       FROM size_grading_scans s JOIN matrices m ON m.id = s.matrix_id
      WHERE s.status = 'flagged' ORDER BY s.created_at DESC LIMIT 20`,
  );
  return {
    progress: { measured, total },
    entries: [...cutEntries, ...loose].slice(0, limit),
    needsCheck: flagged.rows.map((f) => ({ scanId: f.id, name: f.name, size: f.size, flags: f.flags ?? [], createdAt: f.created_at })),
    groups: groups.size,
  };
}

/* ───────────────────────────── cut groups ───────────────────────────── */

export async function listCutGroups(pool: Pool) {
  const r = await pool.query<{
    id: string; name: string; profile: string | null; note: string | null; products: string; created_at: string;
    sizes_total: string; sizes_measured: string; flagged: string;
  }>(
    `WITH member_sizes AS (
       SELECT mm.cut_group_id, upper(trim(cs.size)) AS size,
              bool_or(EXISTS (SELECT 1 FROM size_grading_measurements g WHERE g.custom_sku_id = cs.id AND g.view = 'front')) AS measured
         FROM size_grading_cut_group_members mm
         JOIN custom_skus cs ON cs.matrix_id = mm.matrix_id AND cs.archived = false
                            AND cs.size IS NOT NULL AND trim(cs.size) <> ''
        GROUP BY mm.cut_group_id, upper(trim(cs.size))
     )
     SELECT g.id, g.name, g.profile, g.note, g.created_at,
            (SELECT count(*) FROM size_grading_cut_group_members x WHERE x.cut_group_id = g.id) AS products,
            (SELECT count(*) FROM member_sizes s WHERE s.cut_group_id = g.id) AS sizes_total,
            (SELECT count(*) FROM member_sizes s WHERE s.cut_group_id = g.id AND s.measured) AS sizes_measured,
            (SELECT count(*) FROM size_grading_scans sc WHERE sc.cut_group_id = g.id AND sc.status = 'flagged') AS flagged
       FROM size_grading_cut_groups g
      ORDER BY g.name`,
  );
  return r.rows.map((g) => ({
    id: g.id, name: g.name, profile: g.profile, note: g.note, createdAt: g.created_at,
    products: Number(g.products), sizesTotal: Number(g.sizes_total), sizesMeasured: Number(g.sizes_measured), flagged: Number(g.flagged),
  }));
}

export async function cutGroupDetail(pool: Pool, id: string) {
  const g = await pool.query<{ id: string; name: string; profile: string | null; note: string | null }>(
    `SELECT id, name, profile, note FROM size_grading_cut_groups WHERE id = $1::uuid`, [id],
  );
  if (!g.rows[0]) return null;
  const members = await pool.query<{ matrix_id: string; name: string | null; upc: string | null; vendor: string | null; image: string | null; category: string | null; subcategory_1: string | null }>(
    `SELECT m.id AS matrix_id, m.description AS name, m.upc, m.vendor, m.shopify_featured_image_url AS image, m.category, m.subcategory_1
       FROM size_grading_cut_group_members mm JOIN matrices m ON m.id = mm.matrix_id
      WHERE mm.cut_group_id = $1::uuid ORDER BY m.description`,
    [id],
  );
  /* Latest front reading per size across the cut — the cut's size chart. */
  const chart = await pool.query<{ size: string; points_cm: Record<string, number>; measured_at: string; source: string; scan_id: string | null }>(
    `SELECT DISTINCT ON (upper(trim(cs.size))) upper(trim(cs.size)) AS size, g.points_cm, g.measured_at, g.source, g.scan_id
       FROM size_grading_measurements g
       JOIN custom_skus cs ON cs.id = g.custom_sku_id
       JOIN size_grading_cut_group_members mm ON mm.matrix_id = cs.matrix_id
      WHERE mm.cut_group_id = $1::uuid AND g.view = 'front' AND cs.size IS NOT NULL
      ORDER BY upper(trim(cs.size)), g.measured_at DESC`,
    [id],
  );
  const sizes = await pool.query<{ size: string }>(
    `SELECT DISTINCT upper(trim(cs.size)) AS size FROM custom_skus cs
       JOIN size_grading_cut_group_members mm ON mm.matrix_id = cs.matrix_id
      WHERE mm.cut_group_id = $1::uuid AND cs.archived = false AND cs.size IS NOT NULL AND trim(cs.size) <> ''`,
    [id],
  );
  return {
    ...g.rows[0],
    members: members.rows.map((m) => ({ ...m, profileGuess: profileForProduct(m.category, m.subcategory_1, m.name) })),
    sizes: sizes.rows.map((s) => s.size).sort((a, b) => sizeRank(a) - sizeRank(b)),
    chart: chart.rows.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)),
  };
}

/**
 * A product joining a cut gets the cut's existing readings for its sizes —
 * the same pattern was already measured. Copied rows keep the scan they came
 * from, so "redo" on that scan takes them back too.
 */
export async function backfillMember(pool: Pool, cutGroupId: string, matrixId: string, userId: string | null): Promise<number> {
  const latest = await pool.query<{ size: string; points_cm: Record<string, number>; garment_type: string; px_per_cm: string | null; scan_id: string | null }>(
    `SELECT DISTINCT ON (upper(trim(cs.size))) upper(trim(cs.size)) AS size, g.points_cm, g.garment_type, g.px_per_cm, g.scan_id
       FROM size_grading_measurements g
       JOIN custom_skus cs ON cs.id = g.custom_sku_id
       JOIN size_grading_cut_group_members mm ON mm.matrix_id = cs.matrix_id
      WHERE mm.cut_group_id = $1::uuid AND cs.matrix_id <> $2::uuid AND g.view = 'front' AND cs.size IS NOT NULL
      ORDER BY upper(trim(cs.size)), g.measured_at DESC`,
    [cutGroupId, matrixId],
  );
  let n = 0;
  for (const l of latest.rows) {
    const r = await pool.query(
      `INSERT INTO size_grading_measurements
         (custom_sku_id, garment_type, points_cm, px_per_cm, type_overridden, measured_by, note, view, source, scan_id)
       SELECT cs.id, $3, $4::jsonb, $5, false, $6, 'Copied from cut group', 'front', 'cut-group', $7
         FROM custom_skus cs
        WHERE cs.matrix_id = $1::uuid AND cs.archived = false AND upper(trim(cs.size)) = $2
          AND NOT EXISTS (SELECT 1 FROM size_grading_measurements x WHERE x.custom_sku_id = cs.id AND x.view = 'front')`,
      [matrixId, l.size, l.garment_type, JSON.stringify(l.points_cm), l.px_per_cm, userId, l.scan_id],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

/* ─────────────────────────────── review ─────────────────────────────── */

export async function listScans(pool: Pool, opts: { status?: string; limit?: number; cutGroupId?: string; matrixId?: string }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status && opts.status !== "all") { args.push(opts.status); where.push(`s.status = $${args.length}`); }
  if (opts.cutGroupId) { args.push(opts.cutGroupId); where.push(`s.cut_group_id = $${args.length}::uuid`); }
  if (opts.matrixId) { args.push(opts.matrixId); where.push(`s.matrix_id = $${args.length}::uuid`); }
  args.push(Math.max(1, Math.min(200, opts.limit ?? 50)));
  const r = await pool.query(
    `SELECT s.id, s.matrix_id, m.description AS name, m.upc, s.size, cs.color_code AS color, s.profile, s.status,
            s.flags, s.points_cm, s.applied_to, s.created_at, s.ai_model, s.ai_cost_usd, s.dropbox_path, s.dropbox_error,
            s.review_note, g.name AS cut_group, (s.photo_key IS NOT NULL) AS has_photo, u.email AS by_email
       FROM size_grading_scans s
       JOIN matrices m ON m.id = s.matrix_id
       JOIN custom_skus cs ON cs.id = s.custom_sku_id
       LEFT JOIN size_grading_cut_groups g ON g.id = s.cut_group_id
       LEFT JOIN users u ON u.id = s.created_by
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.created_at DESC
      LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

export async function getScan(pool: Pool, id: string) {
  const r = await pool.query(
    `SELECT s.*, m.description AS name, m.upc, cs.color_code AS color, cs.sku, g.name AS cut_group,
            (s.photo_key IS NOT NULL) AS has_photo, u.email AS by_email
       FROM size_grading_scans s
       JOIN matrices m ON m.id = s.matrix_id
       JOIN custom_skus cs ON cs.id = s.custom_sku_id
       LEFT JOIN size_grading_cut_groups g ON g.id = s.cut_group_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = $1::uuid`,
    [id],
  );
  const s = r.rows[0];
  if (!s) return null;
  const profile = PROFILE_BY_ID[s.profile as GradingProfileId];
  return { ...s, profileDef: profile ?? null };
}

/**
 * approve: the reading stands. redo: the reading is taken back — every row
 * the scan wrote is deleted, so the size returns to the queue. flag: back to
 * "needs your check".
 */
export async function reviewScan(pool: Pool, id: string, action: "approve" | "redo" | "flag", note: string | null, userId: string | null) {
  const status = action === "approve" ? "approved" : action === "redo" ? "redo" : "flagged";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    /* A redone scan's readings are gone; approving it again would show
       "approved" with nothing behind it. Measure the garment again instead. */
    const cur = await client.query<{ status: string }>(`SELECT status FROM size_grading_scans WHERE id = $1::uuid FOR UPDATE`, [id]);
    if (!cur.rows[0]) { await client.query("ROLLBACK"); return null; }
    if (cur.rows[0].status === "redo") { await client.query("ROLLBACK"); return { status: "redo", removed: 0, refused: true as const }; }
    await client.query(
      `UPDATE size_grading_scans SET status = $2, review_note = COALESCE($3, review_note), reviewed_at = now(), reviewed_by = $4
        WHERE id = $1::uuid`,
      [id, status, note, userId],
    );
    let removed = 0;
    if (action === "redo") {
      const d = await client.query(`DELETE FROM size_grading_measurements WHERE scan_id = $1::uuid`, [id]);
      removed = d.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return { status, removed };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ─────────────────────────────── config ─────────────────────────────── */

export async function latestRelease(pool: Pool): Promise<{ version: string; apkUrl: string; sha1: string | null; notes: string | null } | null> {
  const r = await pool.query<{ version: string; apk_url: string; sha1: string | null; notes: string | null }>(
    `SELECT version, apk_url, sha1, notes FROM grading_app_releases ORDER BY created_at DESC LIMIT 1`,
  ).catch(() => ({ rows: [] as { version: string; apk_url: string; sha1: string | null; notes: string | null }[] }));
  const x = r.rows[0];
  return x ? { version: x.version, apkUrl: x.apk_url, sha1: x.sha1, notes: x.notes } : null;
}

export function profilesForApp() {
  return GRADING_PROFILES;
}
