import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getDirectSession, touchDirectSession } from "@/lib/server/raw-test-direct";
import {
  subscribeAntennaTestStream,
  publishAntennaTestLifecycle,
} from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE for a direct-binary raw-test session. Browser opens this immediately
 * after POST /direct/start; 25-s ping doubles as the session-keepalive.
 * Reuses the antenna-test-hub for fan-out so the existing read-stream hook
 * on the client works unchanged.
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
  const s = getDirectSession(sessionId);
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
      // If the binary already exited before the browser opened the stream
      // (common when the bridge is held by prod and the binary returns in
      // < 1 s), re-emit the final lifecycle event so the operator sees
      // why no reads ever flowed.
      if (s.endedAt !== null && s.endReason) {
        publishAntennaTestLifecycle(sessionId, "ended", s.endReason);
      }
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
          touchDirectSession(sessionId);
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
