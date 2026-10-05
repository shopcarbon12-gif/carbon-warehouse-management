import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { createHandoffSession } from "@/lib/image-handoff-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a phone-camera hand-off session for a product; returns the scan
 *  URL + a QR image. Desktop-only (an authenticated WMS session — proxy.ts no
 *  longer exposes this route publicly; the phone never calls it). */
async function POST_handler(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { matrixId?: unknown; purpose?: unknown };
  const matrixId = typeof body?.matrixId === "string" ? body.matrixId.trim() : null;
  /* Which page is waiting for the photo. It only changes what the phone page
     says — the heading, the send button, and the advice when the computer has
     stopped listening — so it travels in the scan URL rather than the session
     row: an old QR code with no parameter still means Studio. */
  const purpose = body?.purpose === "size-grading" ? "size-grading" : null;
  let s;
  try {
    s = await createHandoffSession(matrixId);
  } catch (e) {
    console.error("[image-handoff] create failed:", (e as Error)?.message || e);
    return NextResponse.json({ error: "Could not start a phone session — database unavailable." }, { status: 503 });
  }
  const proto = (request.headers.get("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim();
  const origin = host ? `${proto}://${host}` : new URL(request.url).origin;
  const scanUrl = `${origin}/image-upload/${s.id}${purpose ? `?for=${purpose}` : ""}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(scanUrl)}`;
  return NextResponse.json({ sessionId: s.id, scanUrl, qrCodeUrl, expiresAt: s.expiresAt });
}

export const POST = withActivity("image-handoff/session", POST_handler);
