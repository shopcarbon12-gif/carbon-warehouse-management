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
import { rseriesInventoryTransferSend } from "@/lib/server/lightspeed-rseries-inventory-transfer";
import { insertExternalSystemLog } from "@/lib/queries/external-system-logs";
import { getTransferSlip } from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  slipNumber: z.number().int().positive(),
});

/**
 * POST Lightspeed **Inventory/Transfer/{id}/Send.json** for the transfer linked on the WMS slip.
 * Typically call after **slip-transfer-add-items**. Scope: **employee:transfers**.
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

  const result = await rseriesInventoryTransferSend(creds, lsTid);

  try {
    await insertExternalSystemLog(pool, session.tid, {
      system_name: "lightspeed",
      direction: "OUTBOUND",
      payload_summary: `Inventory/Transfer/${lsTid}/Send http=${result.status} slip=${parsed.data.slipNumber}`,
      status: result.ok ? "ok" : "error",
    });
  } catch (e) {
    console.warn("[slip-transfer-send] log", e);
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        error: "Lightspeed Send failed",
        ls_transfer_id: lsTid,
        slipNumber: parsed.data.slipNumber,
        status: result.status,
        body: result.body,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    slipNumber: parsed.data.slipNumber,
    ls_transfer_id: lsTid,
    lightspeed: result.body,
  });
}
