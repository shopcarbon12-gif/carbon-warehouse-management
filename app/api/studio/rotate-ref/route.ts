import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { downloadStorageObject, tryGetStoragePathFromUrl, uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().min(1).max(2048),
  /** Clockwise. */
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
});

/**
 * POST → a Studio item reference photo turned upright.
 *
 * Flat lays shot from above come out sideways or upside down: the phone cannot
 * tell which way is up, and the files carry no rotation tag. The analysis
 * reports each photo's rotation and Studio calls this to straighten it; the
 * thumbnail's rotate button does the same by hand.
 *
 * The rotated copy is a NEW object (the original stays, like a crop), written
 * under the same prefix the reference proxy serves.
 */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // Only the prefixes item references are written under (same rule as the
  // /api/studio/ref-image proxy).
  const path = tryGetStoragePathFromUrl(parsed.data.url);
  if (
    !path ||
    !(path.startsWith(`carbon-studio/item-refs/${session.tid}/`) || path.startsWith("carbon-studio/handoff/"))
  ) {
    return NextResponse.json({ error: "Not a Studio reference photo." }, { status: 400 });
  }

  try {
    const { body } = await downloadStorageObject(path);
    // Honour any rotation tag first, then turn the pixels.
    const upright = await sharp(Buffer.from(body)).autoOrient().toBuffer();
    const bytes = await sharp(upright).rotate(parsed.data.degrees).jpeg({ quality: 92 }).toBuffer();
    const dest = `carbon-studio/item-refs/${session.tid}/${crypto.randomUUID()}/${Date.now()}.jpg`;
    const uploaded = await uploadBytesToStorage({ path: dest, bytes: new Uint8Array(bytes), contentType: "image/jpeg" });
    return NextResponse.json({ url: uploaded.url });
  } catch (e) {
    console.error("[studio/rotate-ref]", e);
    return NextResponse.json({ error: "Could not rotate this photo." }, { status: 500 });
  }
}

export const POST = withActivity("studio/rotate-ref", POST_handler);
