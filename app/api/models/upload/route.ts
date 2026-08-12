import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BYTES = Number.parseInt(process.env.MODEL_UPLOAD_MAX_FILE_BYTES || "", 10) || 12 * 1024 * 1024;

/**
 * Upload an item/model reference image to R2 (Carbon Studio). Returns its
 * public URL for use as a generation reference. Admin-only (desktop path;
 * the phone-camera path uploads via /api/image-handoff instead).
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

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
  if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  const path = `carbon-studio/item-refs/${session.tid}/${crypto.randomUUID()}/${Date.now()}.${ext}`;
  const uploaded = await uploadBytesToStorage({ path, bytes, contentType: ct });
  return NextResponse.json({ url: uploaded.url, path: uploaded.path });
}
