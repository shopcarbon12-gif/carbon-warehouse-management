import { NextResponse } from "next/server";
import {
  getHandoffSession,
  getHandoffSessionForRecovery,
  addHandoffImages,
  takeAllHandoffImages,
  listHandoffImages,
  touchHandoffPoll,
  HandoffSessionGone,
  HandoffSessionFull,
  type HandoffImage,
} from "@/lib/image-handoff-store";
import { deleteStorageObjects, uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ sessionId: string }> };

const MAX_FILES = 6;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Raster types the desktop can display and OpenAI accepts; the phone page
 *  re-encodes everything else (HEIC) before sending. */
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

function shape(imgs: HandoffImage[]) {
  return imgs.map((img) => ({
    imageId: img.id,
    imageUrl: img.url, // the desktop displays it through /api/studio/ref-image and generates from it
  }));
}

/** Desktop poll — the photos the phone sent since the last poll (the session
 * stays alive so the phone can send more). `?all=1` returns EVERY photo the
 * session ever received, for a panel that stopped listening too early, and
 * works up to 24 h after the session expired. Public (gated by the
 * unguessable session id). */
export async function GET(req: Request, { params }: Ctx) {
  const { sessionId } = await params;
  const all = new URL(req.url).searchParams.get("all") === "1";
  try {
    const s = all ? await getHandoffSessionForRecovery(sessionId) : await getHandoffSession(sessionId);
    if (!s) return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
    if (!all) await touchHandoffPoll(sessionId);
    const fresh = all ? await listHandoffImages(sessionId) : await takeAllHandoffImages(sessionId);
    if (!fresh.length) return NextResponse.json({ ready: false, images: [], expiresAt: s.expiresAt });
    const images = shape(fresh);
    return NextResponse.json({ ready: true, images, expiresAt: s.expiresAt });
  } catch (e) {
    console.error("[image-handoff] poll failed:", (e as Error)?.message || e);
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}

/** Phone upload — no WMS session (gated by session id). Stores to R2, then
 * registers the batch in one transaction that re-checks the session is alive,
 * and tells the phone whether a desktop is currently listening. */
export async function POST(req: Request, { params }: Ctx) {
  const { sessionId } = await params;
  let s;
  try {
    s = await getHandoffSession(sessionId);
  } catch (e) {
    console.error("[image-handoff] upload session check failed:", (e as Error)?.message || e);
    return NextResponse.json({ error: "Database unavailable — try again in a moment." }, { status: 503 });
  }
  if (!s) return NextResponse.json({ error: "Session not found or expired — scan the QR code again." }, { status: 404 });

  // Refuse an oversize body BEFORE buffering it: the per-file check below
  // only ran after the whole multipart had been read into memory.
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_FILES * MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "too large" }, { status: 413 });
  }

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
  if (files.length > MAX_FILES) return NextResponse.json({ error: `max ${MAX_FILES} photos at once` }, { status: 400 });
  // Validate everything before uploading anything.
  for (const file of files) {
    const ct = (file.type || "").toLowerCase();
    if (!ALLOWED_TYPES.has(ct)) {
      return NextResponse.json({ error: `Unsupported photo format${ct ? ` (${ct})` : ""} — use JPG or PNG.` }, { status: 415 });
    }
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "too large" }, { status: 413 });
    if (file.size === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
  }

  const stored: { url: string; path: string }[] = [];
  let seq = 0;
  for (const file of files) {
    const ct = (file.type || "").toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const path = `carbon-studio/handoff/${sessionId}/${Date.now()}-${seq}.${ext}`;
    seq += 1;
    const uploaded = await uploadBytesToStorage({ path, bytes, contentType: ct });
    stored.push({ url: uploaded.url, path: uploaded.path });
  }
  try {
    const ids = await addHandoffImages(sessionId, stored);
    const fresh = await getHandoffSession(sessionId);
    return NextResponse.json({
      ok: true,
      saved: ids.length,
      imageIds: ids,
      // false = no desktop has polled in the last 10 s: the photos are kept,
      // but the operator must collect them from the product's Studio tab.
      listening: fresh?.listening === true,
    });
  } catch (e) {
    // Nothing registered → do not leave the bytes behind.
    void deleteStorageObjects(stored.map((x) => x.path)).catch(() => {});
    if (e instanceof HandoffSessionGone) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof HandoffSessionFull) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error("[image-handoff] register failed:", (e as Error)?.message || e);
    return NextResponse.json({ error: "Could not register the photos — try again." }, { status: 503 });
  }
}
