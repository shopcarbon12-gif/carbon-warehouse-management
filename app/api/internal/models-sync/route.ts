import { NextResponse } from "next/server";
import { z } from "zod";
import { upsertSyncedModel } from "@/lib/modelsRepository";
import { MODEL_SLOT_ORDER, normalizeModelSlots } from "@/lib/modelSlots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HDR = "x-wms-models-sync-secret";

/**
 * Receives a model pushed from carbon-gen, where models are authored.
 *
 * Both apps have always had their own `models` table. They matched only because
 * someone copied six rows across on 2026-06-12 and nobody added a model since;
 * the first new or re-slotted model would have appeared in carbon-gen and never
 * reached the WMS. carbon-gen now pushes here on every save.
 *
 * Machine auth by shared secret (same shape as the ops smoke route): 404 when
 * the secret is unset, so the endpoint simply does not exist until configured.
 */
function syncSecret(): string {
  let s = process.env.WMS_MODELS_SYNC_SECRET?.trim() ?? "";
  /* Coolify's bulk env API sometimes persists a literal quoted string. */
  if (
    s.length >= 2 &&
    ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const bodySchema = z.object({
  model_id: z.string().min(1).max(128),
  user_id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  gender: z.string().min(1).max(32),
  ref_image_urls: z.array(z.string().min(1).max(2048)).max(50),
  ref_slots: z.record(z.string(), z.string()).nullish(),
});

export async function POST(req: Request) {
  const secret = syncSecret();
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (req.headers.get(HDR) !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const slots = normalizeModelSlots(parsed.data.ref_slots);
  /* When the model has a full slot set, trust the slot order over whatever
     order the array arrived in — that ordering is the whole point of slots,
     and it is what the Studio then hands to the image model. */
  const ordered = MODEL_SLOT_ORDER.every((k) => slots[k])
    ? MODEL_SLOT_ORDER.map((k) => slots[k] as string)
    : parsed.data.ref_image_urls;

  try {
    const model = await upsertSyncedModel({
      model_id: parsed.data.model_id,
      user_id: parsed.data.user_id,
      name: parsed.data.name,
      gender: parsed.data.gender,
      ref_image_urls: ordered,
      ref_slots: Object.keys(slots).length ? slots : null,
    });
    return NextResponse.json({ ok: true, model });
  } catch (e) {
    console.error("[internal/models-sync]", e);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
