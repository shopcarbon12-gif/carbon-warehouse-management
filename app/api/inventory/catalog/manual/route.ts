import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { createManualCatalogLine } from "@/lib/server/catalog-manual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  matrixUpc: z.string().min(1).max(64),
  matrixDescription: z.string().min(1).max(512),
  sku: z.string().min(1).max(128),
  vendor: z.string().max(128).optional().nullable(),
  color: z.string().max(64).optional().nullable(),
  size: z.string().max(64).optional().nullable(),
  retailPrice: z.string().max(32).optional().nullable(),
  variantUpc: z.string().max(64).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

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

  try {
    const out = await createManualCatalogLine(pool, parsed.data);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "Duplicate SKU or conflicting unique key" }, { status: 409 });
    }
    console.error("[catalog/manual POST]", e);
    return NextResponse.json({ error: msg.slice(0, 400) || "Create failed" }, { status: 500 });
  }
}
