/**
 * CarbonWMS Email — the campaign photos of a concept (step 3 of the six steps,
 * owner 2026-11-08: "generate only the missing assets with an image model").
 *
 * Every concept has four photos: the hero (H1, landscape) and one per look
 * (L1–L3, portrait). Each is drawn ONCE, at full size, by the picture model
 * chosen in Email → Settings, with every real product as a garment reference
 * (heads blurred, so no face is ever copied), in the owner's style: premium
 * fashion editorial on real Orlando streets. Each photo is then checked by the
 * creative model against the real products (another brand's logo, a changed
 * garment, words in the picture, broken anatomy) and redrawn once if needed.
 * The comps paste these photos in (they are never redrawn inside a comp), and
 * "Convert to email" hands them over as originals.
 */
import sharp from "sharp";
import { toFile } from "openai";
import { uploadBytesToStorage } from "@/lib/storageProvider";
import { openai } from "./config";
import { productGallery, referencePhoto } from "./catalog";
import { PHOTO_STYLE, creativeJson, img, txt, type Concept } from "./creative";
import type { TurnProduct } from "./designer";

export type Shot = { id: string; kind: "hero" | "look"; size: string; prompt: string; products: string[]; path: string | null; qa: string | null; error?: string | null };
export type ShotStage = { view: "shots"; batchId: string; inputFileId: string; refFileIds: string[] };

const NO_BLUR = /\b(hat|cap|beanie|bucket|sunglass|glasses|earring|necklace|chain|jewel|ring|bracelet|scarf|balaclava)/i;

async function faceless(b: Buffer, title: string): Promise<Buffer> {
  if (NO_BLUR.test(title)) return b;
  const m = await sharp(b).metadata();
  if (!m.width || !m.height) return b;
  const band = Math.round(m.height * 0.17);
  const top = await sharp(b).extract({ left: 0, top: 0, width: m.width, height: band }).blur(28).toBuffer();
  return sharp(b).composite([{ input: top, left: 0, top: 0 }]).jpeg({ quality: 90 }).toBuffer();
}

/** The four photos of a concept; a photo whose brief and products did not change keeps its picture. */
export function shotsFor(c: Concept, idOf: (ref: string) => string[], previous: Shot[] | null): Shot[] {
  const want: Omit<Shot, "path" | "qa">[] = [
    { id: "h1", kind: "hero", size: "1536x1024", prompt: c.hero.scene, products: c.hero.products.flatMap(idOf) },
    ...c.looks.map((l) => ({ id: `l${l.id.slice(1)}`, kind: "look" as const, size: "1024x1536", prompt: l.scene, products: l.products.flatMap(idOf) })),
  ];
  return want.map((w) => {
    const prev = previous?.find((p) => p.id === w.id && p.prompt === w.prompt && JSON.stringify(p.products) === JSON.stringify(w.products) && p.path);
    return prev ? { ...prev } : { ...w, path: null, qa: null };
  });
}

function shotPrompt(s: Shot, products: TurnProduct[], labels: string[]): string {
  const names = s.products.map((id) => products.find((p) => p.id === id)?.title).filter(Boolean).join(", ");
  return [
    `A ${s.kind === "hero" ? "landscape campaign hero" : "portrait look"} photograph for CARBON, an Orlando streetwear and going-out store.`,
    PHOTO_STYLE,
    `THE PHOTO: ${s.prompt}`,
    `THE CLOTHES: the people wear exactly these real CARBON products, shown in the reference photos: ${names || "the referenced products"}. Same garment type, cut, colour, wash, fabric, prints, stitching, hardware and any CARBON lettering; where a side is not visible in the photos keep it plain. NEVER another brand's logo, swoosh, stripes, monogram or wordmark on anything.`,
    `THE PEOPLE: new adults (never anyone from a reference photo — their heads are blurred on purpose), natural skin texture, real hands, believable bodies.`,
    `NO words, letters, numbers, logos, watermarks or readable signs anywhere in the picture (shop signs blank or out of focus).`,
    s.kind === "hero"
      ? "Composition: landscape; the people placed to one side, calm space on the other side for a headline; nobody cut at the edges."
      : "Composition: portrait; the whole outfit visible from head to shoes, the person centred with room around them so the photo can be cropped a little.",
    `Reference photos, in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
  ].join("\n\n");
}

async function inputs(s: Shot, products: TurnProduct[]): Promise<{ prompt: string; images: Buffer[] }> {
  const gallery = await productGallery(s.products, 2).catch(() => new Map<string, string[]>());
  const images: Buffer[] = [];
  const labels: string[] = [];
  for (let angle = 0; angle < 2; angle++)
    for (const id of s.products) {
      if (images.length >= 14) break;
      const p = products.find((x) => x.id === id);
      const url = (gallery.get(id) ?? (p?.image ? [p.image] : []))[angle];
      if (!url || !p) continue;
      const b = await referencePhoto(url);
      if (!b) continue;
      images.push(await faceless(b, p.title));
      labels.push(`${p.title}${angle ? " (another angle)" : ""} — garment reference only`);
    }
  return { prompt: shotPrompt(s, products, labels), images };
}

async function draw(model: string, prompt: string, size: string, images: Buffer[]): Promise<string> {
  const common = { model, prompt, size: size as "1024x1024", quality: "high" as const, n: 1 };
  const r = images.length
    ? await openai().images.edit({ ...common, image: await Promise.all(images.map(async (b, i) => toFile(await sharp(b).png().toBuffer(), `ref-${i}.png`, { type: "image/png" }))) })
    : await openai().images.generate({ ...common, moderation: "low" });
  const b64 = r.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no picture");
  return b64;
}

const QA = `You check a campaign photo for CARBON (a streetwear store) against the real products it had to show. Answer JSON {"ok": true|false, "problems": ["…"]}. Problems are only real, visible faults:
- any logo, swoosh, stripes, monogram or wordmark of ANOTHER brand (Nike, Adidas, Jordan, Puma, New Balance, Gucci, LV …) anywhere;
- a garment or shoe that clearly differs from its real product photo (type, colour, wash, print, length, a missing piece);
- words, letters or readable signs in the picture;
- broken anatomy (extra or melted fingers, distorted faces), obvious AI artefacts, a plastic or CGI look;
- a person cut off at the head or feet when the whole outfit should show.
Do not judge location, pose or styling taste.`;

async function check(creativeModel: string, b64: string, s: Shot, products: TurnProduct[]): Promise<string[]> {
  const parts = [txt("The real products:")];
  for (const id of s.products) {
    const p = products.find((x) => x.id === id);
    if (!p?.image) continue;
    const b = await referencePhoto(p.image, 512);
    if (b) parts.push(txt(p.title), img(b, "low"));
  }
  const photo = await sharp(Buffer.from(b64, "base64")).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  parts.push(txt("The photo to check:"), img(photo, "high"));
  const { json } = await creativeJson(creativeModel, QA, parts);
  const problems = Array.isArray(json.problems) ? json.problems.map((x) => String(x).slice(0, 300)).slice(0, 6) : [];
  return problems.length ? problems : json.ok === false ? ["the check found a problem"] : [];
}

async function save(designId: string, turnId: string, s: Shot, b64: string): Promise<string> {
  const jpg = await sharp(Buffer.from(b64, "base64")).flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const path = `email/designs/${designId}/shots/${turnId}-${s.id}.jpg`;
  await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
  return path;
}

/** Check a drawn photo, redraw it once (fast) with the problems if needed, save it. */
async function finish(o: { designId: string; turnId: string; imageModel: string; creativeModel: string }, s: Shot, b64: string, products: TurnProduct[], log: (m: string) => void): Promise<Shot> {
  let pic = b64;
  let problems = await check(o.creativeModel, pic, s, products).catch(() => [] as string[]);
  if (problems.length) {
    log(`[email-shots] ${o.turnId} ${s.id}: redrawing (${problems.join("; ")})`);
    try {
      const inp = await inputs(s, products);
      pic = await draw(o.imageModel, `${inp.prompt}\n\nA FIRST ATTEMPT HAD THESE FAULTS — fix every one:\n- ${problems.join("\n- ")}`, s.size, inp.images);
      problems = await check(o.creativeModel, pic, s, products).catch(() => [] as string[]);
    } catch (e) {
      log(`[email-shots] ${o.turnId} ${s.id}: redraw failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { ...s, path: await save(o.designId, o.turnId, s, pic), qa: problems.length ? problems.join("; ") : null, error: null };
}

/** Fast: draw every missing photo now, all at once. */
export async function drawShotsFast(o: { designId: string; turnId: string; imageModel: string; creativeModel: string }, shots: Shot[], products: TurnProduct[], log: (m: string) => void): Promise<Shot[]> {
  return Promise.all(
    shots.map(async (s) => {
      if (s.path) return s;
      try {
        const inp = await inputs(s, products);
        return await finish(o, s, await draw(o.imageModel, inp.prompt, s.size, inp.images), products, log);
      } catch (e) {
        return { ...s, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
      }
    }),
  );
}

/** Batch: one OpenAI batch with every missing photo (half price). */
export async function submitShots(o: { turnId: string; imageModel: string }, shots: Shot[], products: TurnProduct[]): Promise<ShotStage | null> {
  const todo = shots.filter((s) => !s.path);
  if (!todo.length) return null;
  const ai = openai();
  const refFileIds: string[] = [];
  const lines: string[] = [];
  for (const s of todo) {
    const inp = await inputs(s, products);
    const ids: string[] = [];
    for (const [i, b] of inp.images.entries()) {
      const f = await ai.files.create({ file: await toFile(await sharp(b).jpeg({ quality: 92 }).toBuffer(), `shot-${o.turnId}-${s.id}-${i}.jpg`, { type: "image/jpeg" }), purpose: "vision" });
      ids.push(f.id);
    }
    refFileIds.push(...ids);
    lines.push(
      JSON.stringify({
        custom_id: `${o.turnId}:${s.id}`,
        method: "POST",
        url: "/v1/images/edits",
        body: { model: o.imageModel, prompt: inp.prompt, size: s.size, quality: "high", moderation: "low", n: 1, images: ids.map((file_id) => ({ file_id })) },
      }),
    );
  }
  const input = await ai.files.create({ file: await toFile(Buffer.from(lines.join("\n") + "\n"), `shots-${o.turnId}.jsonl`, { type: "application/jsonl" }), purpose: "batch" });
  const batch = await ai.batches.create({ input_file_id: input.id, endpoint: "/v1/images/edits", completion_window: "24h", metadata: { email_design_turn: o.turnId, kind: "shots" } });
  return { view: "shots", batchId: batch.id, inputFileId: input.id, refFileIds };
}

/** Batch came back: check and save each photo (a missing one is drawn now). Null while still running. */
export async function collectShots(o: { designId: string; turnId: string; imageModel: string; creativeModel: string }, st: ShotStage, shots: Shot[], products: TurnProduct[], log: (m: string) => void): Promise<Shot[] | null> {
  const ai = openai();
  const b = await ai.batches.retrieve(st.batchId);
  if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status)) return null;
  const got = new Map<string, string>();
  if (b.output_file_id) {
    const text = await (await ai.files.content(b.output_file_id)).text();
    for (const line of text.split("\n").filter(Boolean)) {
      const l = JSON.parse(line) as { custom_id: string; response?: { body?: { data?: { b64_json?: string }[] } } };
      const b64 = l.response?.body?.data?.[0]?.b64_json;
      if (b64) got.set(l.custom_id.split(":").pop()!, b64);
    }
  }
  for (const f of [st.inputFileId, ...st.refFileIds, b.output_file_id, b.error_file_id]) if (f) await ai.files.delete(f).catch(() => {});
  return Promise.all(
    shots.map(async (s) => {
      if (s.path) return s;
      try {
        const b64 = got.get(s.id) ?? (await (async () => {
          const inp = await inputs(s, products);
          return draw(o.imageModel, inp.prompt, s.size, inp.images);
        })());
        return await finish(o, s, b64, products, log);
      } catch (e) {
        return { ...s, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
      }
    }),
  );
}
