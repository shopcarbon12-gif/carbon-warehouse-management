/**
 * GET /api/public/email/countdown?to=<ISO>&bg=&fg=&page= — the live countdown picture in emails
 * (lib/server/email/countdown.ts). Public (inboxes load it); never cached, so every open is current.
 */
import { NextResponse } from "next/server";
import { countdownGif } from "@/lib/server/email/countdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const gif = await countdownGif(new URL(req.url).searchParams);
    return new NextResponse(new Uint8Array(gif), {
      headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
