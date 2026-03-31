import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  addTransferItems,
  getTransferSlip,
  getTransferSlipExportRows,
  setTransferItemsOutcome,
} from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slipNumber: string }> };

const slipPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("append_epcs"),
    epcs: z.array(z.string().min(4).max(64)).min(1),
  }),
  z.object({
    action: z.literal("receive"),
    epcs: z.array(z.string().min(4).max(64)).min(1),
    outcome: z.enum(["received", "missing"]),
  }),
]);

export async function GET(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.MANAGER]);
  if (denied) return denied;

  const { slipNumber: raw } = await ctx.params;
  const slipNumber = Number.parseInt(raw, 10);
  if (!Number.isFinite(slipNumber)) {
    return NextResponse.json({ error: "Invalid slip number" }, { status: 400 });
  }

  const url = new URL(req.url);
  const exportCsv = url.searchParams.get("export") === "csv";

  try {
    if (exportCsv) {
      const rows = await getTransferSlipExportRows(pool, session.tid, slipNumber);
      if (rows.length === 0) {
        const slip = await getTransferSlip(pool, session.tid, slipNumber);
        if (!slip) return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ slipNumber, rows }, { headers: { "Cache-Control": "no-store" } });
    }
    const slip = await getTransferSlip(pool, session.tid, slipNumber);
    if (!slip) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(slip, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[transfer-slips/slip GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

/**
 * Handheld / web: append EPCs to a slip, or mark EPCs received/missing during transfer-in.
 */
export async function POST(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.MANAGER]);
  if (denied) return denied;

  const { slipNumber: raw } = await ctx.params;
  const slipNumber = Number.parseInt(raw, 10);
  if (!Number.isFinite(slipNumber)) {
    return NextResponse.json({ error: "Invalid slip number" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = slipPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    if (parsed.data.action === "append_epcs") {
      await addTransferItems(pool, session.tid, slipNumber, parsed.data.epcs);
      return NextResponse.json({ ok: true, action: "append_epcs" });
    }
    const updated = await setTransferItemsOutcome(
      pool,
      session.tid,
      slipNumber,
      parsed.data.epcs,
      parsed.data.outcome,
    );
    return NextResponse.json({ ok: true, action: "receive", updated });
  } catch (e) {
    if ((e as Error).message === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[transfer-slips/slip POST]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
