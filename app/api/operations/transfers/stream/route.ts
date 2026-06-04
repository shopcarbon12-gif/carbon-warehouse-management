import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { subscribeTransferEvents } from "@/lib/server/transfer-events-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated SSE for the per-location transfer live mirror. The connection
 * is bound to the caller's active location (session.lid); it receives an event
 * whenever a transfer whose source OR destination is that location is committed
 * or received — so the desktop and handheld stay in sync without polling.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
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
      send("retry: 5000\n\n");
      send(": connected\n\n");

      unsubscribe = subscribeTransferEvents(session.tid, session.lid, send);

      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
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
