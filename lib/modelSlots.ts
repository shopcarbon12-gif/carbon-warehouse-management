/**
 * Model reference photo SLOTS.
 *
 * A model's reference photos used to be an unlabelled pile: `ref_image_urls`
 * was whatever order the operator happened to drop the files in, and the
 * generator simply took the first few. Two photos of the same angle crowded
 * out the angle nobody supplied, and nothing recorded which was which.
 *
 * Four named roles fix that. Two carry the FACE (identity lives in facial
 * pixels, so these are shot close), two carry the BODY (height, build and
 * proportions, which a head-and-shoulders photo cannot describe and which
 * matter for full-body catalog output).
 *
 * `ref_image_urls` stays the array the generator consumes — nothing downstream
 * changes — but when a model has slots it is written in SLOT_ORDER, so the
 * order stops being an accident.
 */

export const MODEL_SLOT_ORDER = ["face_front", "face_turn", "body_front", "body_back"] as const;

export type ModelSlotKey = (typeof MODEL_SLOT_ORDER)[number];

export type ModelSlots = Partial<Record<ModelSlotKey, string>>;

export const MODEL_SLOT_LABELS: Record<ModelSlotKey, { title: string; hint: string }> = {
  face_front: {
    title: "Face · straight on",
    hint: "Head and shoulders, square to camera. The identity anchor — everything else is matched against it.",
  },
  face_turn: {
    title: "Face · turned",
    hint: "Head and shoulders at roughly 40°. A genuine turn, not a slight tilt.",
  },
  body_front: {
    title: "Body · front",
    hint: "Full body facing camera, head and feet in frame. Carries height, build and proportions.",
  },
  body_back: {
    title: "Body · back",
    hint: "Full body facing away, head and feet in frame. Used for back-facing poses.",
  },
};

export function isModelSlotKey(value: unknown): value is ModelSlotKey {
  return typeof value === "string" && (MODEL_SLOT_ORDER as readonly string[]).includes(value);
}

/** Keep only real slot keys pointing at non-empty strings. */
export function normalizeModelSlots(value: unknown): ModelSlots {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ModelSlots = {};
  for (const key of MODEL_SLOT_ORDER) {
    const raw = (value as Record<string, unknown>)[key];
    const url = typeof raw === "string" ? raw.trim() : "";
    if (url) out[key] = url;
  }
  return out;
}

/** The slot photos in canonical order — what the generator should receive. */
export function slotsToOrderedUrls(slots: ModelSlots): string[] {
  return MODEL_SLOT_ORDER.map((key) => slots[key] || "").filter(Boolean);
}

export function missingModelSlots(slots: ModelSlots): ModelSlotKey[] {
  return MODEL_SLOT_ORDER.filter((key) => !slots[key]);
}

/**
 * Best-effort slots for a model saved before slots existed. The old array had
 * no roles, so this only guesses the POSITION, never the content — it exists so
 * the editor opens pre-filled rather than blank, and the operator confirms or
 * moves each photo. Never treat the result as authoritative.
 */
export function guessSlotsFromLegacyUrls(urls: string[]): ModelSlots {
  const clean = (Array.isArray(urls) ? urls : []).map((u) => String(u || "").trim()).filter(Boolean);
  const out: ModelSlots = {};
  MODEL_SLOT_ORDER.forEach((key, i) => {
    if (clean[i]) out[key] = clean[i];
  });
  return out;
}
