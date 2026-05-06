import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { eventsSince, getSession } from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * GET /api/handheld/add-on-sessions/<id>/events?lastEventId=<n>&deviceId=<id>
 *
 * Server-Sent Events stream. The server polls add_on_session_events on a
 * 1-second cadence and pushes new rows to the client. This is the cheapest
 * SSE shape that survives Coolify's reverse proxy timeout (Q15 lock; we
 * also send a comment-only keepalive every 25s so the proxy doesn't kill
 * an idle connection).
 *
 * Auth: same as other handheld endpoints (Bearer or edge-key).
 *
 * Catch-up: client sends `Last-Event-ID` (standard SSE header) or
 *  `?lastEventId=<n>` query param. The server replays events with id > N
 *  before going live.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) {
    return new Response("Database unavailable", { status: 503 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return new Response("Invalid id", { status: 400 });

  const url = new URL(req.url);
  const auth = await resolveTenantOrError(req, pool, url.searchParams.get("deviceId") ?? undefined);
  if (auth instanceof Response) return auth;

  const session = await getSession(pool, auth.tenantId, id);
  if (!session) return new Response("Not found", { status: 404 });

  const queryLast = Number.parseInt(url.searchParams.get("lastEventId") ?? "0", 10);
  const headerLast = Number.parseInt(req.headers.get("last-event-id") ?? "0", 10);
  let lastEventId = Math.max(
    Number.isFinite(queryLast) ? queryLast : 0,
    Number.isFinite(headerLast) ? headerLast : 0,
  );

  const encoder = new TextEncoder();
  const POLL_MS = 1000;
  const KEEPALIVE_MS = 25_000;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      let lastKeepalive = Date.now();

      const send = (line: string) => controller.enqueue(encoder.encode(line));

      // Initial event: replay any events newer than lastEventId.
      send(`retry: 5000\n\n`);

      const tick = async (): Promise<void> => {
        if (aborted) return;
        try {
          const rows = await eventsSince(pool, auth.tenantId, id, lastEventId, 200);
          for (const ev of rows) {
            const payload = JSON.stringify({
              id: ev.id,
              type: ev.eventType,
              userId: ev.userId,
              deviceId: ev.deviceId,
              payload: ev.payload,
              at: ev.createdAtIso,
            });
            send(`id: ${ev.id}\nevent: ${ev.eventType}\ndata: ${payload}\n\n`);
            lastEventId = ev.id;
          }
          if (Date.now() - lastKeepalive > KEEPALIVE_MS) {
            send(`: keepalive ${new Date().toISOString()}\n\n`);
            lastKeepalive = Date.now();
          }
        } catch (e) {
          console.error("[add-on-sessions SSE]", e);
        }
        if (!aborted) setTimeout(() => void tick(), POLL_MS);
      };

      req.signal.addEventListener("abort", () => {
        aborted = true;
        try {
          controller.close();
        } catch {}
      });

      void tick();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
