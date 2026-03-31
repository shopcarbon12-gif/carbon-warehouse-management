import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { ensureTenantSettings, updateTenantSettingsPartial } from "@/lib/queries/tenant-settings";

export const dynamic = "force-dynamic";

const epcProfileSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  epcPrefix: z.string().min(1).max(32),
  itemStartBit: z.number().int().min(0).max(255),
  itemLength: z.number().int().min(1).max(128),
  serialStartBit: z.number().int().min(0).max(255),
  serialLength: z.number().int().min(1).max(128),
  isActive: z.boolean(),
});

const patchSchema = z.object({
  epc_settings: z
    .object({
      encodingStandard: z.enum(["SENITRON", "CUSTOM"]).optional(),
      companyPrefix: z.string().min(1).max(32).optional(),
      activeProfileId: z.string().max(64).nullable().optional(),
    })
    .optional(),
  epc_profiles: z.array(epcProfileSchema).max(50).optional(),
  handheld_settings: z
    .object({
      system: z
        .object({
          triggerMode: z.enum(["HOLD_RELEASE", "CLICK"]).optional(),
          vibrateOnRead: z.boolean().optional(),
          beepOnRead: z.boolean().optional(),
        })
        .optional(),
      inventory: z
        .object({
          autoSaveInventoryData: z.boolean().optional(),
          confirmOnQtyChange: z.boolean().optional(),
        })
        .optional(),
      transfer: z
        .object({
          transferOutPowerLock: z.boolean().optional(),
          transferOutAntennaPower: z.number().int().min(0).max(300).optional(),
          transferInAntennaPower: z.number().int().min(0).max(300).optional(),
        })
        .optional(),
      encoding: z
        .object({
          validateEpcChecksum: z.boolean().optional(),
        })
        .optional(),
      itemDetailsTemplate: z.string().max(2000).optional(),
      tagDetailsTemplate: z.string().max(2000).optional(),
    })
    .optional(),
});

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const row = await ensureTenantSettings(pool, session.tid);
    return NextResponse.json(row, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[tenant-settings GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
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
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const p = parsed.data;
  if (!p.epc_settings && !p.epc_profiles && !p.handheld_settings) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    const row = await updateTenantSettingsPartial(pool, session.tid, {
      epc_settings: p.epc_settings,
      epc_profiles: p.epc_profiles,
      handheld_settings: p.handheld_settings,
    });
    return NextResponse.json(row);
  } catch (e) {
    console.error("[tenant-settings PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
