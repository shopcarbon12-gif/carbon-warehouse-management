import type { Pool, PoolClient } from "pg";
import type { SessionPayload } from "@/lib/auth";
import { isSuperAdminRole } from "@/lib/auth/roles";
import { getMembershipRole } from "@/lib/queries/membership-role";

/**
 * One engine for every write to an item's bin (owner, 2026-10-16: "make the
 * desktop and the handheld match"). Before this, the desktop Shelf Map /
 * catalog move, the handheld Bin Assign, Clean (desktop + handheld), Remove
 * from bin and Delete bin each had their own UPDATEs — three different
 * "Move"s, no history for handheld moves, a clean that left items with only a
 * second bin, and Undo buttons that could only re-ADD.
 *
 * An item's home is its primary `bin_id` (the bin that owns the qty) plus
 * `additional_bin_ids` (multi-bin: the product is also shelved there). Every
 * operation here:
 *   1. locks the affected rows,
 *   2. computes each row's new home in one place (planMove / planAdd /
 *      planRemove / revert),
 *   3. writes only rows that still look the way they were read,
 *   4. writes one inventory_audit_logs row per bin each tag entered or left,
 *      attributed to the user and (for the handheld) the device,
 *   5. returns before → after per EPC, which is what an exact Undo replays.
 */

export type BinHome = { bin: string | null; extra: string[] };
export type BinChange = { epc: string; before: BinHome; after: BinHome };
export type BinActor = { userId: string | null; deviceId: string | null };

export type ItemRow = { id: string; epc: string; status: string; custom_sku_id: string | null; bin_id: string | null; extra: string[] | null };

/** Statuses a bin move/add carries (what the bin views list). */
export const BIN_LISTED_STATUSES = ["in-stock", "pending_visibility"] as const;

/**
 * Canonical bin code: upper case, no spaces / dashes / dots / underscores.
 * Handheld screens show "2-B-03-L" and sent that back when creating a bin, so
 * "2B03L" and "2-B-03-L" could both exist and the handheld's normalised
 * lookup picked either one.
 */
export function canonicalBinCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s._-]+/g, "");
}

/** Who made a request: the session user, and the handheld when it came from one. */
export function binActorFrom(req: Request, session: SessionPayload | null, bodyDeviceId?: string | null): BinActor {
  const h = req.headers;
  const header = h.get("x-wms-device-id")?.trim() || null;
  const ua = h.get("user-agent") ?? "";
  const fromHandheld =
    !!h.get("x-carbon-mobile") ||
    /dart|okhttp/i.test(ua) ||
    /^bearer\s/i.test(h.get("authorization") ?? "");
  const device = (bodyDeviceId ?? "").trim() || header || (fromHandheld ? "handheld" : null);
  return { userId: session?.sub ?? null, deviceId: device };
}

export type BinPermission = "assign" | "create" | "clean" | "delete" | "edit";

/**
 * One permission rule for desktop and handheld. Allowed when:
 *   - the membership is admin / manager / member (desktop roles), or
 *   - the user's handheld role allows the matching Bin Assign action
 *     (no handheld role, an empty map, or "Super Admin" = everything — the
 *     same full-access rules as /api/mobile/permissions).
 * `edit` (rename, capacity, active/inactive) has no handheld screen and stays
 * a desktop role action.
 */
export async function canChangeBins(
  pool: Pool,
  session: SessionPayload,
  what: BinPermission,
): Promise<boolean> {
  const role = ((await getMembershipRole(pool, session.sub, session.tid)) ?? "member").trim().toLowerCase();
  if (role === "admin" || role === "manager" || role === "member") return true;
  if (what === "edit") return false;
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
  const putawayEditable = !hidden("fast_putaway") && !hidden("fast_putaway__edit");
  switch (what) {
    case "assign":
      return putawayEditable;
    case "create":
      return putawayEditable && !hidden("fast_putaway__create_bin");
    case "delete":
      return putawayEditable && !hidden("fast_putaway__delete_bin");
    case "clean":
      return (
        (putawayEditable && !hidden("fast_putaway__clean_bin")) ||
        (!hidden("clean_bin") && !hidden("clean_bin__edit") && !hidden("clean_bin__clean_empty_bin"))
      );
    default:
      return false;
  }
}

/** Live (not archived) bins of a location: id → { code, status }. */
export async function liveBinsOf(
  client: Pool | PoolClient,
  locationId: string,
): Promise<Map<string, { code: string; status: string }>> {
  const r = await client.query<{ id: string; code: string; status: string }>(
    `SELECT id::text, code, status FROM bins WHERE location_id = $1::uuid AND archived_at IS NULL`,
    [locationId],
  );
  return new Map(r.rows.map((b) => [b.id, { code: b.code, status: b.status }]));
}

/** Locks and returns the items matching `where` (alias `i`). */
export async function lockItems(
  client: PoolClient,
  where: string,
  params: unknown[],
): Promise<ItemRow[]> {
  const r = await client.query<ItemRow>(
    `SELECT i.id::text, i.epc, i.status, i.custom_sku_id::text AS custom_sku_id, i.bin_id::text AS bin_id,
            ARRAY(SELECT x::text FROM unnest(i.additional_bin_ids) x) AS extra
       FROM items i
      WHERE ${where}
      ORDER BY i.id
      FOR UPDATE OF i`,
    params,
  );
  return r.rows.map((row) => ({ ...row, extra: row.extra ?? [] }));
}

const homeOf = (r: ItemRow): BinHome => ({ bin: r.bin_id, extra: [...(r.extra ?? [])] });

/** MOVE: the tag ends up in `target` only. */
export const planMove = (target: string) => (): BinHome => ({ bin: target, extra: [] });

/**
 * ADD: a tag with no live primary bin gets `target` as its primary; a tag
 * already shelved elsewhere keeps that primary (it owns the qty) and lists
 * `target` as an extra bin. Already here → unchanged.
 */
export const planAdd = (target: string, live: Map<string, unknown>) => (h: BinHome): BinHome => {
  if (!h.bin || !live.has(h.bin)) return { bin: target, extra: h.extra.filter((x) => x !== target) };
  if (h.bin === target || h.extra.includes(target)) return h;
  return { bin: h.bin, extra: [...h.extra, target] };
};

/**
 * Take `binId` off the tag. When it was the primary bin, the first live
 * extra bin becomes the primary (Clean / Delete used to leave such tags with
 * no primary bin at all — 88 LIVE tags on 2026-10-16 that showed "—" in the
 * catalog while Shelf Map listed them).
 */
export const planRemove = (binId: string, live: Map<string, unknown>) => (h: BinHome): BinHome => {
  if (h.bin === binId) {
    const promote = h.extra.find((x) => x !== binId && live.has(x)) ?? null;
    return { bin: promote, extra: h.extra.filter((x) => x !== binId && x !== promote) };
  }
  if (h.extra.includes(binId)) return { bin: h.bin, extra: h.extra.filter((x) => x !== binId) };
  return h;
};

const sameHome = (a: BinHome, b: BinHome) =>
  a.bin === b.bin && a.extra.length === b.extra.length && a.extra.every((x, i) => x === b.extra[i]);

/**
 * Applies `plan` to the locked rows, writes the audit rows and returns the
 * changes. Rows whose home is unchanged are skipped.
 */
export type AppliedChange = BinChange & { status: string; skuId: string | null };

export async function applyBinPlan(
  client: PoolClient,
  tenantId: string,
  rows: ItemRow[],
  plan: (h: BinHome, row: ItemRow) => BinHome | null,
  actor: BinActor,
): Promise<AppliedChange[]> {
  const planned: (BinChange & { id: string; status: string; skuId: string | null })[] = [];
  for (const r of rows) {
    const before = homeOf(r);
    const after = plan(before, r);
    if (!after || sameHome(before, after)) continue;
    planned.push({ id: r.id, epc: r.epc, status: r.status, skuId: r.custom_sku_id, before, after });
  }
  if (planned.length === 0) return [];

  const up = await client.query<{ id: string }>(
    `UPDATE items i
        SET bin_id = p.after_bin,
            additional_bin_ids = p.after_extra
       FROM jsonb_to_recordset($1::jsonb)
            AS p(id uuid, before_bin uuid, before_extra uuid[], after_bin uuid, after_extra uuid[])
      WHERE i.id = p.id
        AND i.bin_id IS NOT DISTINCT FROM p.before_bin
        AND i.additional_bin_ids = p.before_extra
      RETURNING i.id::text`,
    [
      JSON.stringify(
        planned.map((c) => ({
          id: c.id,
          before_bin: c.before.bin,
          before_extra: c.before.extra,
          after_bin: c.after.bin,
          after_extra: c.after.extra,
        })),
      ),
    ],
  );
  const done = new Set(up.rows.map((r) => r.id));
  const changes = planned.filter((c) => done.has(c.id));
  await auditBinChanges(client, tenantId, changes, actor);
  return changes.map(({ epc, before, after, status, skuId }) => ({ epc, before, after, status, skuId }));
}

/** One audit row per bin a tag entered or left (bin_move / bin_add / clean_bin). */
async function auditBinChanges(
  client: PoolClient,
  tenantId: string,
  changes: BinChange[],
  actor: BinActor,
): Promise<void> {
  if (changes.length === 0) return;
  const ids = new Set<string>();
  for (const c of changes) {
    for (const h of [c.before, c.after]) {
      if (h.bin) ids.add(h.bin);
      h.extra.forEach((x) => ids.add(x));
    }
  }
  const codes = new Map(
    (
      await client.query<{ id: string; code: string; archived: boolean }>(
        `SELECT id::text, code, archived_at IS NOT NULL AS archived FROM bins WHERE id = ANY($1::uuid[])`,
        [[...ids]],
      )
    ).rows.map((b) => [b.id, b.archived ? b.code.split("·arch·")[0] : b.code]),
  );
  const code = (id: string | null) => (id ? codes.get(id) ?? "(deleted bin)" : "(homeless)");
  const rows: { epc: string; old: string | null; new: string | null; reason: string }[] = [];
  for (const c of changes) {
    const { before, after } = c;
    if (before.bin !== after.bin) {
      if (after.bin === null) rows.push({ epc: c.epc, old: code(before.bin), new: null, reason: "clean_bin" });
      else rows.push({ epc: c.epc, old: code(before.bin), new: code(after.bin), reason: "bin_move" });
    }
    for (const x of after.extra) {
      if (!before.extra.includes(x) && x !== before.bin) {
        rows.push({ epc: c.epc, old: code(after.bin), new: code(x), reason: "bin_add" });
      }
    }
    for (const x of before.extra) {
      if (!after.extra.includes(x) && x !== after.bin) {
        rows.push({ epc: c.epc, old: code(x), new: null, reason: "clean_bin" });
      }
    }
  }
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO inventory_audit_logs
       (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
     SELECT $1::uuid, 'ADJUSTMENT', 'EPC', r.epc, r.old, r.new, r.reason, NULL, $3::uuid, $4
       FROM jsonb_to_recordset($2::jsonb) AS r(epc text, old text, new text, reason text)`,
    [tenantId, JSON.stringify(rows), actor.userId, actor.deviceId],
  );
}

/**
 * Exact Undo: puts each listed tag back to `before`, but only when it still
 * looks exactly like `after` — anything changed since (sold, moved by someone
 * else) is left alone and counted as skipped.
 */
export async function revertBinChanges(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  changes: BinChange[],
  actor: BinActor,
): Promise<{ reverted: BinChange[]; skipped: number }> {
  if (changes.length === 0) return { reverted: [], skipped: 0 };
  const byEpc = new Map(changes.map((c) => [c.epc.toUpperCase(), c]));
  const rows = await lockItems(client, `i.location_id = $1::uuid AND i.epc = ANY($2::text[])`, [
    locationId,
    [...byEpc.keys()],
  ]);
  const applied = await applyBinPlan(client, tenantId, rows, (h, row) => {
    const c = byEpc.get(row.epc.toUpperCase());
    if (!c || !sameHome(h, c.after)) return null;
    return { bin: c.before.bin, extra: [...c.before.extra] };
  }, actor);
  const reverted = applied.map(({ epc, before, after }) => ({ epc, before, after }));
  return { reverted, skipped: changes.length - reverted.length };
}

/**
 * Home bin (custom_skus.assigned_bin_id) — where a colour belongs even with
 * no stock. MOVE sets it for the whole colour; ADD only fills it when the
 * colour has none (or it points at a deleted bin); emptying a bin clears it
 * for the SKUs whose home it was, so the catalog stops showing a bin that no
 * longer holds the product.
 */
export async function setHomeBin(
  client: PoolClient,
  skuIdsSql: string,
  params: unknown[],
  targetParamIndex: number,
  mode: "move" | "add",
): Promise<void> {
  await client.query(
    `UPDATE custom_skus cs
        SET assigned_bin_id = $${targetParamIndex}::uuid
      WHERE cs.id IN (${skuIdsSql})
        ${mode === "add"
          ? `AND (cs.assigned_bin_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM bins hb WHERE hb.id = cs.assigned_bin_id AND hb.archived_at IS NULL))`
          : ""}
        AND cs.assigned_bin_id IS DISTINCT FROM $${targetParamIndex}::uuid`,
    params,
  );
}

export async function clearHomeBin(
  client: PoolClient,
  binId: string,
  skuIds: string[] | "all",
): Promise<void> {
  if (skuIds === "all") {
    await client.query(`UPDATE custom_skus SET assigned_bin_id = NULL WHERE assigned_bin_id = $1::uuid`, [binId]);
  } else if (skuIds.length > 0) {
    await client.query(
      `UPDATE custom_skus SET assigned_bin_id = NULL WHERE assigned_bin_id = $1::uuid AND id = ANY($2::uuid[])`,
      [binId, skuIds],
    );
  }
}

/** What goes back to a client (and is replayed by Undo): EPC + before/after only. */
export const publicChanges = (changes: AppliedChange[]): BinChange[] =>
  changes.map(({ epc, before, after }) => ({ epc, before, after }));

/** Tags the operator saw in the bin (bin views list in-stock + pending only). */
export const listedCount = (changes: AppliedChange[]) =>
  changes.filter((c) => (BIN_LISTED_STATUSES as readonly string[]).includes(c.status)).length;

/** A product group as a custom_skus id subquery whose placeholders start at `first`. */
export type SkuGroup = { sql: (first: number) => string; params: unknown[] };

/**
 * Bin Assign / Shelf Map / catalog Move & Add — one rule for the desktop and
 * the handheld. Acts on the group's in-stock + pending-visibility tags at the
 * location:
 *   - "move": every tag of the group ends up in the target only, wherever it
 *     was (primary or extra). The three Moves used to differ: Shelf Map moved
 *     only tags whose primary was the cell's bin (0 when the product was
 *     there as an extra bin), catalog and handheld moved everything.
 *   - "add": see planAdd.
 *   - "homeless": only tags with no live primary bin get the target.
 * Inactive or deleted target bins are refused (the handheld used to accept
 * them and Shelf Map then hid the line). Must run inside a transaction.
 */
export async function assignToBin(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  targetBinId: string,
  mode: "move" | "add" | "homeless",
  group: SkuGroup,
  actor: BinActor,
): Promise<{ changes: AppliedChange[]; targetCode: string }> {
  const t = await client.query<{ code: string; status: string }>(
    `SELECT b.code, b.status
       FROM bins b
       JOIN locations l ON l.id = b.location_id
      WHERE b.id = $1::uuid AND b.location_id = $2::uuid AND l.tenant_id = $3::uuid AND b.archived_at IS NULL
      LIMIT 1`,
    [targetBinId, locationId, tenantId],
  );
  if (!t.rows[0]) throw new Error("BAD_REQUEST:Target bin not found");
  if (t.rows[0].status === "inactive") throw new Error("BAD_REQUEST:Target bin is inactive");

  const rows = await lockItems(
    client,
    `i.location_id = $1::uuid
       AND i.status IN ('in-stock', 'pending_visibility')
       AND i.custom_sku_id IN (${group.sql(2)})`,
    [locationId, ...group.params],
  );
  const live = await liveBinsOf(client, locationId);
  const plan =
    mode === "move"
      ? planMove(targetBinId)
      : mode === "add"
        ? planAdd(targetBinId, live)
        : (h: BinHome): BinHome =>
            !h.bin || !live.has(h.bin) ? { bin: targetBinId, extra: h.extra.filter((x) => x !== targetBinId) } : h;
  const changes = await applyBinPlan(client, tenantId, rows, plan, actor);
  await setHomeBin(client, group.sql(1), [...group.params, targetBinId], group.params.length + 1, mode === "move" ? "move" : "add");
  return { changes, targetCode: t.rows[0].code };
}
