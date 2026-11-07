import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/transcribe — the AI Designer's microphone: a short voice
 * recording (multipart "audio", up to 3 minutes) → text in the chat box.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { transcribe } from "@/lib/server/email/designer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const form = await req.formData().catch(() => null);
  const f = form?.get("audio");
  if (!f || typeof f !== "object" || !("arrayBuffer" in f)) return NextResponse.json({ error: "No recording" }, { status: 400 });
  const file = f as File;
  if (file.size > 24 * 1024 * 1024) return NextResponse.json({ error: "The recording is too long" }, { status: 400 });
  const type = (file.type || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "webm";
  try {
    return NextResponse.json({ text: await transcribe(Buffer.from(await file.arrayBuffer()), type, `voice.${ext}`) });
  } catch (e) {
    return NextResponse.json({ error: `Could not understand the recording: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

export const POST = withActivity("email/transcribe", POST_handler);
