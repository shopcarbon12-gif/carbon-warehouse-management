import { NextResponse } from "next/server";
import { getHandoffSession, setHandoffImage, consumeHandoffImage } from "@/lib/image-handoff-store";
import { uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ sessionId: string }> };

/** Desktop poll. `?consume=1` returns + clears the captured image. Public
 * (gated by the unguessable session id). */
export async function GET(req: Request, { params }: Ctx) {
  const { sessionId } = await params;
  const consume = new URL(req.url).searchParams.get("consume") === "1";
  const s = getHandoffSession(sessionId);
  if (!s) return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
  if (!s.imageUrl) return NextResponse.json({ ready: false });
  if (consume) {
    const url = consumeHandoffImage(sessionId);
    return NextResponse.json({ ready: true, imageUrl: url });
  }
  return NextResponse.json({ ready: true, imageUrl: s.imageUrl });
}

/** Phone upload — no WMS session (gated by session id). Stores to R2. */
export async function POST(req: Request, { params }: Ctx) {
  const { sessionId } = await params;
  const s = getHandoffSession(sessionId);
  if (!s) return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  const ct = (file.type || "image/jpeg").toLowerCase();
  if (!ct.startsWith("image/")) return NextResponse.json({ error: "must be an image" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) return NextResponse.json({ error: "empty file" }, { status: 400 });
  if (bytes.byteLength > 15 * 1024 * 1024) return NextResponse.json({ error: "too large" }, { status: 413 });

  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  const path = `carbon-studio/handoff/${sessionId}/${Date.now()}.${ext}`;
  const uploaded = await uploadBytesToStorage({ path, bytes, contentType: ct });
  setHandoffImage(sessionId, uploaded.url);
  return NextResponse.json({ ok: true });
}
