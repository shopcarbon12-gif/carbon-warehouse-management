import { subscribeEdgeScanStream } from "@/lib/server/edge-scan-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic SSE endpoint — subscribes to the same edge-scan
 * hub the dashboard uses, but accepts Bearer auth with WMS_DEVICE_KEY
 * so the operations team can run a curl-and-tee capture from the VPS
 * without juggling browser session cookies.
 *
 * The published payload is built BEFORE the passes_formula filter
 * (`epcs = body.reads.map(r => r.epcHex)` in cdm-agents.ts), so this
 * stream sees every raw EPC the reader emits — including the noise
 * rows that the c091eb8 filter drops on the way to cdm_reads. That's
 * exactly what the operator needs to debug "the reader is reading a
 * lot of EPCs but only one passes the formula" scenarios.
 *
 * Query params:
 *   tenantId  (uuid, required)
 *   locationId (uuid, required)
 *
 * Auth:
 *   Authorization: Bearer <WMS_DEVICE_KEY>
 *
 * SAFE TO LEAVE IN: rate-limited by hub fan-out itself; no DB writes,
 * no mutations, just a passive listener. Bearer-only (no session
 * cookie path) so it can never accidentally leak into a logged-in
 * browser tab.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const expected = process.env.WMS_DEVICE_KEY;
  if (!m || !expected || m[1].trim() !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const tenantId = (url.searchParams.get("tenantId") ?? "").trim();
  const locationId = (url.searchParams.get("locationId") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(locationId)) {
    return new Response(
      JSON.stringify({ error: "tenantId + locationId UUIDs required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
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
      send(": connected diagnostic-stream\n\n");
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
