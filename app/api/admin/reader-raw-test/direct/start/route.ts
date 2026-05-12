import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { spawnDirectSession } from "@/lib/server/raw-test-direct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Direct-binary raw reader test — no WMS data, no agent, no rules.
 * Spawns `new_monsoonreader --console` against the bridge IP the operator
 * types in. Operator is responsible for pausing the reader in production
 * first (single-client WIZnet bridge).
 */
const bodySchema = z.object({
  bridgeIp: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  bridgePort: z.coerce.number().int().min(1).max(65535).default(10002),
  antennaNumber: z.coerce.number().int().min(1).max(8).default(1),
  powerDbm: z.coerce.number().min(0).max(33),
  readTimeMs: z.coerce.number().int().min(250).max(5000).default(1000),
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

  const result = spawnDirectSession({
    tenantId: session.tid,
    startedBy: (session as { uid?: string }).uid ?? null,
    bridgeIp: parsed.data.bridgeIp,
    bridgePort: parsed.data.bridgePort,
    antennaNumber: parsed.data.antennaNumber,
    powerArg: Math.round(parsed.data.powerDbm * 10),
    readTimeMs: parsed.data.readTimeMs,
  });

  if (!result.ok) {
    const status =
      result.reason === "busy" ? 409 :
      result.reason === "bad_ip" ? 400 :
      500;
    const msg =
      result.reason === "busy"
        ? "Another direct-mode test is already running on this server. Stop it first."
        : result.reason === "bad_ip"
          ? "Bridge IP must be a private RFC-1918 address (10.x, 172.16-31.x, 192.168.x)."
          : `Failed to spawn MonsoonReader binary: ${result.detail ?? "unknown"}`;
    return NextResponse.json({ error: msg }, { status });
  }

  return NextResponse.json(
    {
      sessionId: result.session.id,
      bridgeIp: result.session.bridgeIp,
      bridgePort: result.session.bridgePort,
      antennaNumber: result.session.antennaNumber,
      powerArg: result.session.powerArg,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
