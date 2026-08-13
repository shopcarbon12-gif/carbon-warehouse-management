import { NextResponse } from "next/server";
import { getHandoffSession, addHandoffImage, takeAllHandoffImages } from "@/lib/image-handoff-store";
import { uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ sessionId: string }> };

/** Desktop poll — returns the next photo the phone sent (session stays alive so
 * the phone can send more). Public (gated by the unguessable session id). */
export async function GET(_req: Request, { params }: Ctx) {
  const { sessionId } = await params;
  const s = getHandoffSession(sessionId);
  if (!s) return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
  const fresh = takeAllHandoffImages(sessionId);
  if (!fresh.length) return NextResponse.json({ ready: false, images: [] });
  const images = fresh.map((img) => ({
    imageId: img.id,
    imageUrl: img.url, // used server-side for generation (authed R2 fallback)
    previewUrl: `/api/image-handoff/image?s=${encodeURIComponent(sessionId)}&i=${encodeURIComponent(img.id)}`,
  }));
  return NextResponse.json({
    ready: true,
    images,
    // Back-compat single fields (first image).
    imageId: images[0].imageId,
    imageUrl: images[0].imageUrl,
    previewUrl: images[0].previewUrl,
  });
}

/** Phone upload — no WMS session (gated by session id). Stores to R2 + keeps
 * the session alive so "send another" works. */
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
  // Accept one OR many files (phone burst of up to 6): all form entries named
  // "file". Falls back to the single legacy "file" field.
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (files.length > 6) return NextResponse.json({ error: "max 6 photos at once" }, { status: 400 });

  let saved = 0;
  for (const file of files) {
    const ct = (file.type || "image/jpeg").toLowerCase();
    if (!ct.startsWith("image/")) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.byteLength) continue;
    if (bytes.byteLength > 15 * 1024 * 1024) return NextResponse.json({ error: "too large" }, { status: 413 });
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const path = `carbon-studio/handoff/${sessionId}/${Date.now()}-${saved}.${ext}`;
    const uploaded = await uploadBytesToStorage({ path, bytes, contentType: ct });
    addHandoffImage(sessionId, { url: uploaded.url, path: uploaded.path });
    saved += 1;
  }
  if (saved === 0) return NextResponse.json({ error: "no valid images" }, { status: 400 });
  return NextResponse.json({ ok: true, saved });
}
