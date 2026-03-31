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
import { rseriesPostJsonV3 } from "@/lib/server/lightspeed-rseries-client";
import {
  chunkTransferItems,
  rseriesInventoryTransferAddItems,
  rseriesInventoryTransferSend,
} from "@/lib/server/lightspeed-rseries-inventory-transfer";
import { insertExternalSystemLog } from "@/lib/queries/external-system-logs";
import { getTransferSlip, setTransferSlipLsTransferId } from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

const transferLineSchema = z.object({
  itemID: z.number().int().positive(),
  toSend: z.number().int().positive().max(999_999),
});

const bodySchema = z.object({
  slipNumber: z.number().int().positive(),
  sendingShopID: z.number().int().positive(),
  receivingShopID: z.number().int().positive(),
  note: z.string().max(2000).optional(),
  /** Optional: add up to 500 lines (batched 100/call) after the transfer is created. */
  transferItems: z.array(transferLineSchema).max(500).optional(),
  /** Optional: POST Send.json after adds (or immediately if no lines). */
  send: z.boolean().optional(),
});

function parseTransferIdFromLightspeedBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const t = o.Transfer;
  if (Array.isArray(t) && t[0] && typeof t[0] === "object") {
    const id = (t[0] as Record<string, unknown>).transferID;
    return id != null ? String(id) : null;
  }
  if (t && typeof t === "object") {
    const id = (t as Record<string, unknown>).transferID;
    return id != null ? String(id) : null;
  }
  return null;
}

/**
 * Creates a Lightspeed R-Series **Inventory → Transfer** (shop-to-shop) and stores `transferID`
 * on `transfer_slips.ls_transfer_id`. Optional **transferItems** (Lightspeed **itemID** + **toSend**) and **send**
 * run AddItems (100/batch) and Send in the same request. For an existing slip, use **slip-transfer-add-items**
 * and **slip-transfer-send** instead.
 *
 * OAuth app needs **employee:transfers** scope.
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

  const { slipNumber, sendingShopID, receivingShopID, note, transferItems, send } = parsed.data;

  const slip = await getTransferSlip(pool, session.tid, slipNumber);
  if (!slip) {
    return NextResponse.json({ error: "Transfer slip not found" }, { status: 404 });
  }
  if (slip.ls_transfer_id?.trim()) {
    return NextResponse.json(
      { error: "Slip already linked to Lightspeed", ls_transfer_id: slip.ls_transfer_id },
      { status: 409 },
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

  const noteText =
    note?.trim() ||
    `CarbonWMS slip #${slipNumber} (${slip.source_loc} → ${slip.dest_loc})`.slice(0, 2000);

  const needBy = new Date().toISOString();
  const lsBody: Record<string, unknown> = {
    note: noteText,
    archived: "false",
    needBy,
    sendingShopID: String(sendingShopID),
    receivingShopID: String(receivingShopID),
  };

  const result = await rseriesPostJsonV3(creds, "Inventory/Transfer", lsBody);
  const transferId = result.ok ? parseTransferIdFromLightspeedBody(result.body) : null;

  try {
    await insertExternalSystemLog(pool, session.tid, {
      system_name: "lightspeed",
      direction: "OUTBOUND",
      payload_summary: `Inventory/Transfer POST slip=${slipNumber} shops=${sendingShopID}→${receivingShopID} http=${result.status} id=${transferId ?? "?"}`,
      status: result.ok && transferId ? "ok" : "error",
    });
  } catch (e) {
    console.warn("[sync-slip-transfer] external_system_logs insert failed", e);
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: "Lightspeed Inventory/Transfer create failed", status: result.status, body: result.body },
      { status: 502 },
    );
  }
  if (!transferId) {
    return NextResponse.json(
      { error: "Lightspeed response missing transferID", body: result.body },
      { status: 502 },
    );
  }

  const updated = await setTransferSlipLsTransferId(pool, session.tid, slipNumber, transferId);
  if (!updated) {
    return NextResponse.json({ error: "Failed to persist ls_transfer_id" }, { status: 500 });
  }

  const out: Record<string, unknown> = {
    ok: true,
    slipNumber,
    ls_transfer_id: transferId,
    lightspeed_create: result.body,
  };

  if (transferItems?.length) {
    const batches = chunkTransferItems(transferItems);
    const batchResults: { batch: number; ok: boolean; status: number }[] = [];
    for (let b = 0; b < batches.length; b++) {
      const chunk = batches[b]!;
      const addRes = await rseriesInventoryTransferAddItems(creds, transferId, chunk);
      batchResults.push({ batch: b, ok: addRes.ok, status: addRes.status });
      if (!addRes.ok) {
        try {
          await insertExternalSystemLog(pool, session.tid, {
            system_name: "lightspeed",
            direction: "OUTBOUND",
            payload_summary: `AddItems failed after create slip=${slipNumber} ls_transfer=${transferId} batch=${b} http=${addRes.status}`,
            status: "error",
          });
        } catch (e) {
          console.warn("[sync-slip-transfer] log", e);
        }
        return NextResponse.json(
          {
            error: "Transfer created and saved, but Lightspeed AddItems failed",
            slipNumber,
            ls_transfer_id: transferId,
            lightspeed_create: result.body,
            add_items_batch_results: batchResults,
            add_items_error_body: addRes.body,
          },
          { status: 502 },
        );
      }
    }
    out.add_items_batch_results = batchResults;
    out.lines_added = transferItems.length;
    try {
      await insertExternalSystemLog(pool, session.tid, {
        system_name: "lightspeed",
        direction: "OUTBOUND",
        payload_summary: `Inventory/Transfer/${transferId}/AddItems batches=${batches.length} slip=${slipNumber}`,
        status: "ok",
      });
    } catch (e) {
      console.warn("[sync-slip-transfer] add items log", e);
    }
  }

  if (send) {
    const sendRes = await rseriesInventoryTransferSend(creds, transferId);
    out.send_ok = sendRes.ok;
    out.send_status = sendRes.status;
    out.lightspeed_send = sendRes.body;
    try {
      await insertExternalSystemLog(pool, session.tid, {
        system_name: "lightspeed",
        direction: "OUTBOUND",
        payload_summary: `Inventory/Transfer/${transferId}/Send http=${sendRes.status} slip=${slipNumber}`,
        status: sendRes.ok ? "ok" : "error",
      });
    } catch (e) {
      console.warn("[sync-slip-transfer] send log", e);
    }
    if (!sendRes.ok) {
      return NextResponse.json(
        {
          error: "Transfer created (and items may be added), but Lightspeed Send failed",
          ...out,
        },
        { status: 502 },
      );
    }
  }

  return NextResponse.json(out);
}
