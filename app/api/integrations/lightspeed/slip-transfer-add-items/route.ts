import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import {
  credentialsLookUsableForRSeries,
  getLightspeedCredentialsForSync,
} from "@/lib/server/infrastructure-settings-table";
import {
  chunkTransferItems,
  rseriesInventoryTransferAddItems,
} from "@/lib/server/lightspeed-rseries-inventory-transfer";
import { insertExternalSystemLog } from "@/lib/queries/external-system-logs";
import { aggregateLightspeedTransferLinesFromSlipEpcs, getTransferSlip } from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

const transferLineSchema = z.object({
  itemID: z.number().int().positive(),
  toSend: z.number().int().positive().max(999_999),
});

const bodySchema = z
  .object({
    slipNumber: z.number().int().positive(),
    /** When true, build **items** from slip EPCs → `items` → `custom_skus.ls_item_id` (needs live catalog sync). */
    fromSlipEpcs: z.boolean().optional(),
    items: z.array(transferLineSchema).max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.fromSlipEpcs) return;
    if (!data.items?.length) {
      ctx.addIssue({
        code: "custom",
        message: "Provide items[] or set fromSlipEpcs: true",
        path: ["items"],
      });
    }
  });

/**
 * Adds lines to an existing Lightspeed **Inventory/Transfer** linked on `transfer_slips.ls_transfer_id`
 * (create the transfer first via **POST /api/integrations/lightspeed/sync-slip-transfer**).
 * Optional **fromSlipEpcs: true** resolves **itemID** + **toSend** from slip EPCs and `custom_skus.ls_item_id`.
 * Batches of up to 100 lines per Lightspeed request. Scope: **employee:transfers**.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const slip = await getTransferSlip(pool, session.tid, parsed.data.slipNumber);
  if (!slip) return NextResponse.json({ error: "Transfer slip not found" }, { status: 404 });
  const lsTid = slip.ls_transfer_id?.trim();
  if (!lsTid) {
    return NextResponse.json(
      { error: "Slip has no ls_transfer_id — run sync-slip-transfer first" },
      { status: 400 },
    );
  }

  let items = parsed.data.items ?? [];
  let fromSlipMeta: { unresolved_line_count: number } | null = null;
  if (parsed.data.fromSlipEpcs) {
    const built = await aggregateLightspeedTransferLinesFromSlipEpcs(pool, session.tid, parsed.data.slipNumber);
    fromSlipMeta = { unresolved_line_count: built.unresolved_line_count };
    items = built.lines;
    if (items.length === 0) {
      return NextResponse.json(
        {
          error:
            "fromSlipEpcs produced no lines — ensure EPCs exist in WMS items and custom_skus.ls_item_id is set (live R-Series catalog sync).",
          unresolved_line_count: built.unresolved_line_count,
        },
        { status: 400 },
      );
    }
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

  const batches = chunkTransferItems(items);
  const batchResults: { batch: number; ok: boolean; status: number }[] = [];
  let lastBody: unknown;

  for (let b = 0; b < batches.length; b++) {
    const chunk = batches[b]!;
    const result = await rseriesInventoryTransferAddItems(creds, lsTid, chunk);
    lastBody = result.body;
    batchResults.push({ batch: b, ok: result.ok, status: result.status });
    if (!result.ok) {
      try {
        await insertExternalSystemLog(pool, session.tid, {
          system_name: "lightspeed",
          direction: "OUTBOUND",
          payload_summary: `Inventory/Transfer/${lsTid}/AddItems batch=${b} http=${result.status} slip=${parsed.data.slipNumber}${parsed.data.fromSlipEpcs ? " fromSlipEpcs" : ""} (partial failure)`,
          status: "error",
        });
      } catch (e) {
        console.warn("[slip-transfer-add-items] log", e);
      }
      return NextResponse.json(
        {
          error: "Lightspeed AddItems failed",
          ls_transfer_id: lsTid,
          slipNumber: parsed.data.slipNumber,
          batchResults,
          body: result.body,
        },
        { status: 502 },
      );
    }
  }

  try {
    await insertExternalSystemLog(pool, session.tid, {
      system_name: "lightspeed",
      direction: "OUTBOUND",
      payload_summary: `Inventory/Transfer/${lsTid}/AddItems batches=${batches.length} lines=${items.length} slip=${parsed.data.slipNumber}${parsed.data.fromSlipEpcs ? " fromSlipEpcs" : ""}`,
      status: "ok",
    });
  } catch (e) {
    console.warn("[slip-transfer-add-items] log", e);
  }

  return NextResponse.json({
    ok: true,
    slipNumber: parsed.data.slipNumber,
    ls_transfer_id: lsTid,
    lines_added: items.length,
    fromSlipEpcs: Boolean(parsed.data.fromSlipEpcs),
    from_slip_epcs: fromSlipMeta,
    batchResults,
    lightspeed: lastBody,
  });
}
