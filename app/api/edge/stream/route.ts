import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { subscribeEdgeScanStream } from "@/lib/server/edge-scan-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated SSE: only events whose **location** matches the user’s session `lid` are delivered.
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
  const tenantId = session.tid;
  const locationId = session.lid;

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

      unsubscribe = subscribeEdgeScanStream(tenantId, locationId, send);

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
