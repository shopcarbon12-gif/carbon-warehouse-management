import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listExceptions, updateExceptionState } from "@/lib/queries/exceptions";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await withDb(
    (sql) => listExceptions(sql, session.tid, session.lid),
    [],
  );
  return NextResponse.json(rows);
}

const patchSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(["new", "assigned", "resolved", "ignored"]),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const ok = await withDb(
    (sql) =>
      updateExceptionState(
        sql,
        session.tid,
        parsed.data.id,
        parsed.data.state,
        session.sub,
      ),
    false,
  );
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
