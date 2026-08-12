import { NextResponse } from "next/server";
import { createHandoffSession } from "@/lib/image-handoff-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a phone-camera hand-off session; returns the scan URL + a QR image. */
export async function POST(request: Request) {
  const s = createHandoffSession();
  const proto = (request.headers.get("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim();
  const origin = host ? `${proto}://${host}` : new URL(request.url).origin;
  const scanUrl = `${origin}/image-upload/${s.id}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(scanUrl)}`;
  return NextResponse.json({ sessionId: s.id, scanUrl, qrCodeUrl });
}
