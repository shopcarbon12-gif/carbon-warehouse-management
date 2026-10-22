/**
 * The owner's Shopify gallery order (2026-10-17 / 2026-10-20), shared by
 * Bulk Studio › Upload and the Studio tab's "Manage & publish images":
 *  - one block per colour, in the colour order the Shopify gallery already has
 *    (the owner's option order); colours not on Shopify yet follow;
 *  - each block: full-length front first (that colour's ★ main picture), then
 *    front close-ups, details, side / three-quarter, other, seated, back
 *    close-up, and the full back last (a side shot leads when there is no
 *    straight full-length front);
 *  - a generated run goes in the block of the colour it actually shows
 *    (/api/studio/which-colour), its full-length front becomes that colour's ★;
 *  - current Shopify pictures no colour block claims ("untied") go last.
 * Accessory shot sets ("· Shot N") keep shot order — Shot 1 is the hero.
 *
 * Client-safe: plain fetch to the WMS's own /api routes, no server imports.
 */

/* Gallery position of each generated pose (owner 2026-10-20, Challenge T-Shirt):
   hero full-length front, then the front crops / close-ups / detail, then the
   second full-length shot, seated, back close-up, full back last. */
export const RANK_MALE: Record<number, number> = { 1: 0, 3: 1, 5: 2, 6: 3, 2: 4, 8: 5, 7: 6, 4: 7 };
export const RANK_FEMALE: Record<number, number> = { 1: 0, 4: 1, 7: 2, 5: 3, 6: 4, 3: 5, 8: 6, 2: 7 };
/* The same order for the product's current Shopify pictures, by the view each shows. */
export const EX_RANK: Record<string, number> = { "full-front": 0, "front-close": 1, detail: 2, side: 3, other: 4, seated: 5, "back-close": 6, back: 7 };
export const VIEW_MALE: Record<number, string> = { 1: "front", 2: "front", 3: "front close-up", 4: "back", 5: "front close-up", 6: "detail", 7: "back close-up", 8: "lifestyle" };
export const VIEW_FEMALE: Record<number, string> = { 1: "front", 2: "back", 3: "three-quarter", 4: "front close-up", 5: "detail", 6: "front", 7: "front close-up", 8: "lifestyle" };

/** One picture in the gallery being arranged. */
export type GalleryCard = {
  key: string;
  kind: "existing" | "new";
  mediaId?: string;
  /** Base64 (no data: prefix) for new pictures. */
  b64?: string;
  src: string;
  alt: string;
  /** The colour this picture is the ★ main picture for ("" = none). */
  color: string;
  selected: boolean;
  label: string;
  /** Current Shopify pictures: the view it shows (for the order). */
  view?: string;
};

/** What the order needs of a card. */
type Orderable = { color: string; view?: string };

/** Gallery rank of a generated pose (accessory shot sets keep shot order). */
export function poseRank(pose: number, female: boolean, accessory: boolean): number {
  return accessory ? pose : (female ? RANK_FEMALE : RANK_MALE)[pose] ?? 9;
}

/** The view a generated pose shows, for its label. */
export function poseView(pose: number, female: boolean, accessory: boolean): string {
  return accessory ? `shot ${pose}` : (female ? VIEW_FEMALE : VIEW_MALE)[pose] ?? `pose ${pose}`;
}

export const picKey = (u: string | null | undefined) => (u ?? "").split("?")[0];

/** The colour of the block a position sits in: the nearest ★ to its left, else the first colour. */
export function blockColourAt<T extends Orderable>(cards: T[], idx: number, colours: string[]): string {
  for (let i = idx; i >= 0; i--) if (cards[i].color) return cards[i].color;
  return colours[0] ?? "";
}

/** Generated + current pictures in the owner's order (see the file header). */
export function arrange<T extends Orderable>(gen: Map<string, T[]>, existing: T[], include: boolean, colours: string[]): T[] {
  const blocks = new Map<string, T[]>();
  const untied: T[] = [];
  let cur = "";
  for (const c of existing) {
    if (c.color) cur = c.color;
    if (cur) blocks.set(cur, [...(blocks.get(cur) ?? []), { ...c }]);
    else untied.push({ ...c });
  }
  /* Each colour's current pictures in the owner's order: a full-length shot
     first (a three-quarter one if there is no straight front), then crops and
     details, seated, back close-up, back last. */
  for (const [colour, list] of blocks) {
    const hasFront = list.some((c) => c.view === "full-front");
    const r = (c: T) => (!hasFront && c.view === "side" ? -1 : EX_RANK[c.view ?? "other"] ?? 4);
    const sorted = list.map((c, i) => ({ c, i })).sort((a, b) => r(a.c) - r(b.c) || a.i - b.i).map((x) => x.c);
    sorted.forEach((c, i) => (c.color = i === 0 ? colour : ""));
    blocks.set(colour, sorted);
  }
  const order = [...colours, ...[...gen.keys()].filter((c) => !colours.includes(c))];
  const out: T[] = [];
  for (const colour of order) {
    const g = gen.get(colour) ?? [];
    const e = include ? blocks.get(colour) ?? [] : [];
    if (g.length) {
      /* The new full-length front becomes this colour's ★ main picture. */
      e.forEach((c) => (c.color = ""));
      g.forEach((c, i) => (c.color = i === 0 ? colour : ""));
    }
    out.push(...g, ...e);
  }
  if (include) out.push(...untied);
  return out;
}

/** A product variant as /api/inventory/catalog/matrices/[id] returns it. */
export type GalleryVariant = { color: string | null; shopify_variant_id?: string | null; shopify_image_url?: string | null; archived?: boolean };

/** The product's colours, from its live (unarchived) variants, in variant order. */
export function liveColours(variants: GalleryVariant[]): string[] {
  return [...new Set(variants.filter((v) => !v.archived).map((v) => (v.color || "").trim()).filter(Boolean))];
}

/** Which current Shopify picture is which colour's main picture: picture key → colour (first variant wins). */
export function mainPictureColours(variants: GalleryVariant[]): Map<string, string> {
  const mainOf = new Map<string, string>();
  for (const v of variants) {
    if (v.archived) continue;
    if (v.shopify_image_url && v.color && !mainOf.has(picKey(v.shopify_image_url))) mainOf.set(picKey(v.shopify_image_url), v.color.trim());
  }
  return mainOf;
}

/** Blocks follow the colour order the Shopify gallery already has; colours not on Shopify yet follow. */
export function galleryColourOrder(existing: Orderable[], colours: string[]): string[] {
  const shopOrder = existing.map((c) => c.color).filter((c, i, a) => c && a.indexOf(c) === i);
  return [...shopOrder, ...colours.filter((c) => !shopOrder.includes(c))];
}

/** The view each current Shopify picture shows ("other" where unknown). */
export async function classifyViews(urls: string[]): Promise<string[]> {
  if (!urls.length) return [];
  const vj = await fetch("/api/studio/classify-views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  })
    .then((x) => x.json() as Promise<{ views?: string[] }>)
    .catch(() => ({ views: [] as string[] }));
  return urls.map((_, i) => vj.views?.[i] ?? "other");
}

/** Which of the product's colours a picture (data: URL) actually shows; null = could not tell. */
export async function whichColour(image: string, colours: string[], item: string): Promise<string | null> {
  const wj = await fetch("/api/studio/which-colour", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, colours, item }),
  })
    .then((x) => x.json() as Promise<{ colour?: string | null }>)
    .catch(() => ({ colour: null }));
  return wj.colour ?? null;
}

/** A PNG base64 → a small JPEG data URL (for the low-detail colour check). PNG data URL outside a browser. */
async function smallJpeg(pngB64: string): Promise<string> {
  const png = `data:image/png;base64,${pngB64}`;
  if (typeof document === "undefined") return png;
  try {
    const img = new Image();
    img.src = png;
    await img.decode();
    const k = Math.min(1, 768 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  } catch {
    return png;
  }
}

export type StudioGalleryInput = {
  matrixId: string;
  /** The product's current Shopify pictures, as GET /api/shopify/media?matrixId= returns them. */
  media: { id: string; url: string; alt?: string | null }[];
  /** The generated crops to add (label "P1 · Pose 3" / "P1 · Shot 2"; b64 = PNG, no prefix). */
  crops: { id: string; label: string; b64: string }[];
  /** The model's gender ("female" uses the women's pose order; anything else the men's). */
  gender: string;
  /** The colour the crops were generated in ("" = the product's first colour). */
  colour: string;
  /** Keep the current Shopify pictures in the order. */
  includeShopify: boolean;
};

export type StudioGalleryResult = {
  /** Everything in the owner's order; `color` set on each colour's ★ main picture. */
  cards: GalleryCard[];
  /** The current Shopify pictures in that same order and with those ★ marks (for "include current Shopify pictures"). */
  existing: GalleryCard[];
  /** Colour blocks in order. */
  colours: string[];
  /** The colour block the generated pictures went in. */
  shownColour: string;
  /** Set when the pictures show another colour than the one requested. */
  note: string | null;
};

/**
 * The Studio's "Manage & publish images": its generated crops + the current
 * Shopify pictures in the same order Bulk Studio › Upload gives them. Learns
 * each colour's main picture from the product's variants, the view of every
 * current picture (classify-views) and the colour the crops actually show
 * (which-colour). A failed lookup degrades to fewer marks, never an error.
 */
export async function orderStudioGallery(input: StudioGalleryInput): Promise<StudioGalleryResult> {
  let variants: GalleryVariant[] = [];
  let item = "";
  try {
    const r = await fetch(`/api/inventory/catalog/matrices/${input.matrixId}`, { cache: "no-store" });
    if (r.ok) {
      const d = (await r.json()) as { matrix?: { description?: string | null }; variants?: GalleryVariant[] };
      variants = d.variants ?? [];
      item = d.matrix?.description ?? "";
    }
  } catch {
    /* no variants: no ★ from Shopify, one block */
  }
  const colours = liveColours(variants);
  const mainOf = mainPictureColours(variants);
  const views = await classifyViews(input.media.map((m) => m.url));
  const existing: GalleryCard[] = input.media.map((m, i) => ({
    view: views[i] ?? "other",
    key: `ex-${m.id}`,
    kind: "existing",
    mediaId: m.id,
    src: m.url,
    alt: m.alt ?? "",
    color: mainOf.get(picKey(m.url)) ?? "",
    selected: true,
    label: `Shopify ${i + 1}`,
  }));

  /* Generated pictures, in the owner's pose order (accessory shot sets: shot order). */
  const female = (input.gender || "").toLowerCase() === "female";
  const poseOf = (label: string) => Number(label.match(/(?:Pose|Shot) (\d+)/)?.[1] ?? 0);
  const accessory = input.crops.some((c) => / · Shot \d+/.test(c.label));
  const asked = (input.colour || colours[0] || "").trim();
  const colour = colours.find((c) => c.toUpperCase() === asked.toUpperCase()) ?? asked;
  const gen = input.crops
    .filter((c) => c.b64)
    .map((c, i) => ({ c, i, pose: poseOf(c.label) }))
    .sort((a, b) => poseRank(a.pose, female, accessory) - poseRank(b.pose, female, accessory) || a.pose - b.pose || a.i - b.i)
    .map(({ c, pose }): GalleryCard => ({
      key: `new-${c.id}`,
      kind: "new",
      b64: c.b64,
      src: `data:image/png;base64,${c.b64}`,
      alt: "",
      color: "",
      selected: true,
      label: `${colour} · ${poseView(pose, female, accessory)}`,
    }));

  /* The colour the pictures actually show decides their block. */
  let shown = colour;
  let note: string | null = null;
  if (colours.length > 1 && gen[0]?.b64) {
    const wc = await whichColour(await smallJpeg(gen[0].b64), colours, item);
    if (wc && wc.toUpperCase() !== colour.toUpperCase()) {
      shown = wc;
      note = `The pictures were made as ${colour || "this colour"} but show ${wc} — they are in ${wc}'s block.`;
    }
  }
  const genMap = new Map<string, GalleryCard[]>();
  if (gen.length) genMap.set(shown, gen);
  const order = galleryColourOrder(existing, colours);
  const all = arrange(genMap, existing, true, order);
  return {
    cards: input.includeShopify ? all : all.filter((c) => c.kind === "new"),
    existing: all.filter((c) => c.kind === "existing"),
    colours: order,
    shownColour: shown,
    note,
  };
}
