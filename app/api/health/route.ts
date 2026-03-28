import { NextResponse } from "next/server";

/**
 * Liveness only (Docker / Coolify / Traefik). Must stay fast and must not depend on Postgres —
 * otherwise a slow or restarting DB marks the whole app unhealthy.
 */
export async function GET() {
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
