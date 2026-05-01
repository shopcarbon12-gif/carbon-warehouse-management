import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  getSession,
  updateSessionFlags,
} from "@/lib/server/antenna-test-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    powerArg: z.coerce.number().int().min(100).max(330).optional(),
    readTimeMs: z.coerce.number().int().min(250).max(5000).optional(),
    cycleMode: z.enum(["infinite", "oscillating"]).optional(),
    tagFocus: z.coerce.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Empty patch" });

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  flags: patchSchema,
});

export async function POST(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const s = getSession(parsed.data.sessionId);
  if (!s) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (s.tenantId !== userSession.tid)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const updated = updateSessionFlags(s.id, parsed.data.flags);
  if (!updated) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ ok: true, flags: updated.flags });
}
