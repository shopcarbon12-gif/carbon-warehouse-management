import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { insertExternalSystemLog } from "@/lib/queries/external-system-logs";
import { getSkuPushTargetsForLocation } from "@/lib/queries/pos-compare";
import {
  credentialsLookUsableForRSeries,
  getLightspeedCredentialsForSync,
} from "@/lib/server/infrastructure-settings-table";
import { rseriesPutItemShopQoh } from "@/lib/server/lightspeed-rseries-item-qoh";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  skus: z.array(z.string().min(1).max(256)).max(5000).optional(),
  note: z.string().max(2000).optional(),
  /** Defaults to session location; must belong to the tenant. */
  locationId: z.string().uuid().optional(),
  /** Overrides `locations.lightspeed_shop_id` for this request. */
  shopID: z.number().int().positive().optional(),
});

function envPushEnabled(): boolean {
  return String(process.env.WMS_LS_PUSH_ITEM_SHOP ?? "").trim() === "1";
}

function maxPushSkus(): number {
  const n = Number.parseInt(String(process.env.WMS_LS_PUSH_MAX_SKUS ?? "40").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 40;
  return Math.min(500, Math.floor(n));
}

function defaultShopFromEnv(): number | null {
  const raw = String(process.env.WMS_LS_PUSH_DEFAULT_SHOP_ID ?? "").trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** When false (default), SKUs with WMS in-stock count 0 are not PUT (avoids zeroing LS QOH for empty WMS). */
function envAllowZeroQohPush(): boolean {
  return String(process.env.WMS_LS_PUSH_ALLOW_ZERO_QOH ?? "").trim() === "1";
}

/**
 * When **WMS_LS_PUSH_ITEM_SHOP=1**, writes WMS in-stock counts to Lightspeed per SKU via
 * `PUT …/Item/{itemID}.json` (**ItemShop.qoh**) for the session location’s **lightspeed_shop_id**
 * (or **shopID** / **WMS_LS_PUSH_DEFAULT_SHOP_ID**).
 *
 * Otherwise records a **stub** row in `sync_jobs` + `external_system_logs` (no LS write).
 *
 * **Inventory transfers:** receive / complete in the **Lightspeed Retail UI** only (no documented Receive API
 * on par with Send). Use **sync-slip-transfer** / **slip-transfer-*** for outbound transfer API flows.
 *
 * **Safety:** WMS **in-stock count 0** does not PUT unless **WMS_LS_PUSH_ALLOW_ZERO_QOH=1** (prevents wiping LS QOH when WMS has no tagged stock).
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) raw = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const locationId = parsed.data.locationId?.trim() || session.lid;
  const loc = await pool.query<{ lightspeed_shop_id: number | null }>(
    `SELECT lightspeed_shop_id FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [locationId, session.tid],
  );
  if (!loc.rows[0]) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const shopId =
    parsed.data.shopID ??
    loc.rows[0]!.lightspeed_shop_id ??
    defaultShopFromEnv() ??
    null;

  const skusRequested = parsed.data.skus ?? [];
  const idempotency_key = `ls-push-${randomUUID()}`;
  const pushLive = envPushEnabled();

  if (!pushLive) {
    try {
      await pool.query(
        `INSERT INTO sync_jobs (
           tenant_id, location_id, job_type, status, idempotency_key, payload, error, attempts, updated_at
         )
         VALUES ($1::uuid, $2::uuid, 'lightspeed_push', 'completed', $3, $4::jsonb, NULL, 0, now())`,
        [
          session.tid,
          locationId,
          idempotency_key,
          JSON.stringify({
            skus: skusRequested,
            note: parsed.data.note ?? null,
            recorded_at: new Date().toISOString(),
            user_id: session.sub,
            implementation: "stub_record_only",
            stub_message:
              "Set WMS_LS_PUSH_ITEM_SHOP=1 to PUT Item ItemShop qoh. Until then only sync_jobs + external logs are written.",
          }),
        ],
      );

      try {
        await insertExternalSystemLog(pool, session.tid, {
          system_name: "lightspeed",
          direction: "OUTBOUND",
          payload_summary: `lightspeed_push stub sku_count=${skusRequested.length} job=${idempotency_key}`,
          status: "recorded",
        });
      } catch (e) {
        console.warn("[integrations/lightspeed/push] external_system_logs", e);
      }

      return NextResponse.json({
        ok: true,
        stub: true,
        job_key: idempotency_key,
        sku_count: skusRequested.length,
        message:
          "Recorded push intent only. Enable WMS_LS_PUSH_ITEM_SHOP=1, R-Series OAuth, location lightspeed_shop_id (or shopID in body), and run a live catalog sync so custom_skus.ls_item_id is populated.",
      });
    } catch (e) {
      console.error("[integrations/lightspeed/push]", e);
      return NextResponse.json({ error: "Could not record push" }, { status: 500 });
    }
  }

  if (!shopId) {
    return NextResponse.json(
      {
        error:
          "Missing Lightspeed shop: set locations.lightspeed_shop_id, pass shopID in the JSON body, or WMS_LS_PUSH_DEFAULT_SHOP_ID.",
      },
      { status: 400 },
    );
  }

  const creds = await getLightspeedCredentialsForSync(pool, session.tid);
  if (!credentialsLookUsableForRSeries(creds)) {
    return NextResponse.json(
      {
        error:
          "R-Series OAuth credentials incomplete. Set LS_ACCOUNT_ID, LS_CLIENT_ID, LS_CLIENT_SECRET, LS_REFRESH_TOKEN.",
      },
      { status: 400 },
    );
  }

  const cap = maxPushSkus();
  const skus = skusRequested.slice(0, cap);
  if (skusRequested.length > cap) {
    /* trimmed */
  }

  if (skus.length === 0) {
    return NextResponse.json({ error: "No SKUs to push (empty skus array)" }, { status: 400 });
  }

  const targets = await getSkuPushTargetsForLocation(pool, session.tid, locationId, skus);
  const bySku = new Map(targets.map((t) => [t.sku, t]));
  const allowZero = envAllowZeroQohPush();
  const results: {
    sku: string;
    ok: boolean;
    http?: number;
    skipped?: string;
    ls_item_id?: string;
    wms_qoh?: number;
  }[] = [];

  for (const sku of skus) {
    const t = bySku.get(sku);
    if (!t) {
      results.push({ sku, ok: false, skipped: "unknown_sku" });
      continue;
    }
    if (!t.ls_item_id) {
      results.push({ sku, ok: false, skipped: "no_ls_item_id" });
      continue;
    }
    const itemId = Number.parseInt(t.ls_item_id, 10);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      results.push({ sku, ok: false, skipped: "invalid_ls_item_id", ls_item_id: t.ls_item_id });
      continue;
    }

    if (t.wms_qoh <= 0 && !allowZero) {
      results.push({
        sku,
        ok: false,
        skipped: "zero_wms_qoh_blocked",
        ls_item_id: t.ls_item_id,
        wms_qoh: t.wms_qoh,
      });
      continue;
    }

    const put = await rseriesPutItemShopQoh(creds, itemId, shopId, t.wms_qoh);
    results.push({
      sku,
      ok: put.ok,
      http: put.status,
      ls_item_id: t.ls_item_id,
    });
    if (!put.ok) {
      try {
        await insertExternalSystemLog(pool, session.tid, {
          system_name: "lightspeed",
          direction: "OUTBOUND",
          payload_summary: `Item/${itemId} PUT qoh=${t.wms_qoh} shop=${shopId} http=${put.status} sku=${sku} (failed)`,
          status: "error",
        });
      } catch (e) {
        console.warn("[integrations/lightspeed/push] log", e);
      }
      return NextResponse.json(
        {
          ok: false,
          error: "Lightspeed Item PUT failed",
          shopID: shopId,
          locationId,
          partial_results: results,
          lightspeed: put.body,
        },
        { status: 502 },
      );
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped);
  const zeroBlocked = skipped.filter((r) => r.skipped === "zero_wms_qoh_blocked").length;

  try {
    await pool.query(
      `INSERT INTO sync_jobs (
         tenant_id, location_id, job_type, status, idempotency_key, payload, error, attempts, updated_at
       )
       VALUES ($1::uuid, $2::uuid, 'lightspeed_push', 'completed', $3, $4::jsonb, NULL, 0, now())`,
      [
        session.tid,
        locationId,
        idempotency_key,
        JSON.stringify({
          skus,
          note: parsed.data.note ?? null,
          shopID: shopId,
          recorded_at: new Date().toISOString(),
          user_id: session.sub,
          implementation: "item_shop_put",
          results,
          allow_zero_qoh: allowZero,
          truncated_from: skusRequested.length > cap ? skusRequested.length : undefined,
        }),
      ],
    );
    await insertExternalSystemLog(pool, session.tid, {
      system_name: "lightspeed",
      direction: "OUTBOUND",
      payload_summary: `lightspeed_push ItemShop qoh ok=${okCount} skipped=${skipped.length} zero_blocked=${zeroBlocked} shop=${shopId} job=${idempotency_key}`,
      status: "ok",
    });
  } catch (e) {
    console.warn("[integrations/lightspeed/push] job/log", e);
  }

  return NextResponse.json({
    ok: true,
    stub: false,
    job_key: idempotency_key,
    shopID: shopId,
    locationId,
    pushed: okCount,
    skipped,
    results,
    warning:
      skipped.length > 0
        ? [
            zeroBlocked > 0
              ? `${zeroBlocked} SKU(s) skipped: WMS in-stock is 0 (blocked unless WMS_LS_PUSH_ALLOW_ZERO_QOH=1).`
              : null,
            skipped.some((s) => s.skipped !== "zero_wms_qoh_blocked")
              ? "Some SKUs skipped: unknown SKU or missing ls_item_id (run a live R-Series catalog sync)."
              : null,
          ]
            .filter(Boolean)
            .join(" ")
        : undefined,
    message:
      okCount > 0
        ? "Updated Lightspeed ItemShop qoh from WMS in-stock counts for this location. Transfers: receive/complete in Lightspeed UI; outbound transfer lines use itemID via catalog ls_item_id or explicit APIs."
        : "No Lightspeed PUTs ran (all SKUs skipped). Common causes: missing ls_item_id, WMS count 0 with zero-qoh protection on, or unknown SKUs.",
  });
}
