import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import {
  createCompareRun,
  materializeExceptionsFromCompare,
  type CompareLineInput,
} from "@/lib/queries/compare";

const lineSchema = z.object({
  sku: z.string(),
  name: z.string(),
  rfid_qty: z.number().int(),
  ext_qty: z.number().int(),
});

const bodySchema = z.object({
  lines: z.array(lineSchema).min(1),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const lines = parsed.data.lines as CompareLineInput[];
  try {
    const result = await withDb(async (sql) => {
      const { runId } = await createCompareRun(sql, session.lid, lines);
      const exc = await materializeExceptionsFromCompare(
        sql,
        session.tid,
        session.lid,
        runId,
      );
      return { runId, exceptionsCreated: exc };
    }, null);
    if (!result) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error("[compare]", e);
    return NextResponse.json({ error: "Compare failed" }, { status: 500 });
  }
}
