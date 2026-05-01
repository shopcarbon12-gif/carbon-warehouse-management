import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  getSession,
  touchSession,
} from "@/lib/server/antenna-test-sessions";
import { subscribeAntennaTestStream } from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated SSE for one antenna-test session. Browser opens this once
 * after POST /start; we keep the connection alive with a 25-s ping that
 * also serves as the session-keepalive on the server-side store (so a
 * tab closure auto-expires the session within ~5 min).
 */
export async function GET(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return new Response(JSON.stringify({ error: "Bad sessionId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const s = getSession(sessionId);
  if (!s) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (s.tenantId !== userSession.tid) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* client disconnected */
        }
      };
      send("retry: 15000\n\n");
      send(": connected\n\n");

      unsubscribe = subscribeAntennaTestStream(sessionId, send);

      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
          touchSession(sessionId);
        } catch {
          if (ping) clearInterval(ping);
        }
      }, 25_000);
    },
    cancel() {
      if (ping) clearInterval(ping);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
