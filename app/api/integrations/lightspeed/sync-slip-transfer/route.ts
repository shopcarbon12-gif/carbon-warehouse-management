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
import { insertExternalSystemLog } from "@/lib/queries/external-system-logs";
import { getTransferSlip, setTransferSlipLsTransferId } from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  slipNumber: z.number().int().positive(),
  sendingShopID: z.number().int().positive(),
  receivingShopID: z.number().int().positive(),
  note: z.string().max(2000).optional(),
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
 * on `transfer_slips.ls_transfer_id`. WMS `source_loc` / `dest_loc` are not auto-mapped to LS shops;
 * the caller supplies numeric **Shop** ids from Lightspeed.
 *
 * OAuth app needs **employee:transfers** scope. See Lightspeed Retail API: Inventory Transfer POST.
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

  const { slipNumber, sendingShopID, receivingShopID, note } = parsed.data;

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

  return NextResponse.json({
    ok: true,
    slipNumber,
    ls_transfer_id: transferId,
    lightspeed: result.body,
  });
}
