/**
 * CarbonWMS Email — "Convert to email" (owner, 2026-11-07).
 *
 * The chosen AI turn's two pictures (desktop + mobile) go to OpenAI with Code
 * Interpreter. OpenAI cuts every photo and graphic out of the pictures, writes
 * ONE responsive email (desktop layout, phone layout through @media), a
 * manifest of everything it found, and packs it all as email-package.zip.
 * CarbonWMS then:
 *   1. downloads the zip (kept in R2 so the owner can download it too);
 *   2. checks every picture (real image, sane size), re-encodes it and hosts
 *      it under /api/public/email-media/…;
 *   3. points the HTML at the hosted pictures, removes anything unsafe, and
 *      checks the personal parts became merge tags;
 *   4. stores the result on the design, ready for a campaign.
 *
 * Runs live (one call, a few minutes): the files OpenAI makes in its container
 * expire 20 minutes after it goes idle, so this step cannot wait for a batch.
 */
import JSZip from "jszip";
import sharp from "sharp";
import { toFile } from "openai";
import type { Pool } from "pg";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";
import { WMS_BASE, openai, textModel } from "./config";
import { SAMPLE_CODE, SAMPLE_NAME, type TurnProduct } from "./designer";
import { LOGO_URLS } from "./catalog";
import { MERGE_TAGS, sanitizeEmailHtml, usedMergeTags } from "./rules";

const MAX_FILES = 60;
const MAX_UNZIPPED = 40 * 1024 * 1024;

export function convertInstructions(desktopName: string, mobileName: string, products: TurnProduct[] = []): string {
  return `You are turning a finished email DESIGN into a real, sendable HTML email package. Use the python tool.

FILES in /mnt/data:
- ${desktopName}: the DESKTOP view (a 600 px email column; the picture's full width = 600 px).
- ${mobileName}: the PHONE view (a 375 px screen; the picture's full width = 375 px).

STEP 1. Look at both pictures closely. List every section top to bottom: logo, headings, paragraphs, photos, buttons, code box, dividers, icons. Note exact words, colours (hex), font style (serif / sans, weight, letter-spacing), alignment and spacing in CSS pixels.

THE LOGO: never cut the CARBON logo out of the pictures and never type it as text. Always use the official file as an <img> with an absolute URL:
- black logo (on a light background): ${LOGO_URLS.longBlack}
- white logo (on a dark background): ${LOGO_URLS.longWhite}
The file is 1200 x 358 px: give it width="180" (or the width the design shows, in CSS px) and height:auto, alt="CARBON", linked to {{shop_url}}.
${
  products.length
    ? `
REAL PRODUCTS shown in this design (from the store's catalog). Link every picture or button that shows one of them to its own page, and use its exact name and price if the design shows them:
${products.map((p) => `- ${p.title} · $${p.price} · ${p.url}${p.image ? ` · product photo: ${p.image}` : ""}`).join("\n")}
For a picture that is simply that product's photo (a product tile), you may use the product photo URL instead of a cut-out (it is sharper); otherwise cut it from the design.
`
    : ""
}
STEP 2. Cut out every PHOTO and GRAPHIC (product / model photos, illustrations, icons, a graphic logo) with PIL, with exact pixel boxes. Cut from the DESKTOP picture (sharper) unless the phone view shows a different photo or a different crop; then also cut the phone version. Save photos as JPEG (quality 88) and graphics with flat colour or transparency as PNG, into package/images/ with short names (hero.jpg, look-1.jpg, logo.png …). Crops must not include text that is not part of the photo. Check each crop by re-opening it and looking at it; fix boxes that are off.

STEP 3. Write package/email.html — ONE email that looks like the desktop design on a computer and like the phone design on a phone:
- Table-based layout, max width 600 px, centered, inline CSS on every element; a single <style> block in <head> only for @media (max-width: 620px) rules that switch to the phone layout (classes like .m-full, .m-stack, .m-hide, .m-show, .m-pad, .m-h1). Phone-only blocks start hidden with style="display:none;max-height:0;overflow:hidden;mso-hide:all" and are shown by the media query.
- ALL text is live HTML text, never a picture of text: headings, paragraphs, prices, button labels, the code box. Fonts: Helvetica, Arial, sans-serif (or Georgia, 'Times New Roman', serif for serif text). Match sizes, weights, letter-spacing, colours.
- Buttons: a table cell with background colour and an <a> inside ("bulletproof" button).
- Every <img>: src="images/<file>", width attribute, style="display:block;width:100%;max-width:...px;height:auto;border:0", meaningful alt text.
- PERSONAL PARTS become merge tags: the sample name "${SAMPLE_NAME}" → {{greeting_name}} ; the sample code "${SAMPLE_CODE}" (or any code shown in a code box) → {{code}} ; a dollar amount of the offer → {{offer_amount}} ; an offer end date → {{offer_ends}}.
- LINKS: the main shopping button → {{code_url}} when there is a code, otherwise {{shop_url}}; other shop links → {{shop_url}}; Instagram → {{instagram_url}}.
- Allowed merge tags only: ${MERGE_TAGS.map((t) => `{{${t}}}`).join(" ")}.
- Leave OUT any unsubscribe link, legal footer and postal address (added automatically). No <script>, no forms, no external CSS or web fonts, no background images.

STEP 4. Write package/manifest.json:
{"subject": "...", "preheader": "...", "colors": {...}, "fonts": [...],
 "sections": [{"type": "logo|hero|heading|text|image|button|code|divider|grid|social", "text": "...", "image": "images/..."}],
 "images": [{"file": "images/hero.jpg", "alt": "...", "from": "desktop|mobile", "box": [x, y, w, h]}],
 "merge_tags": ["greeting_name", ...], "notes": "anything you could not reproduce exactly"}

STEP 5. Zip the package folder (email.html, manifest.json, images/…) as /mnt/data/email-package.zip and print its file list. Answer with one line: DONE.`;
}

type Manifest = { subject?: string; preheader?: string; images?: { file?: string; alt?: string }[]; merge_tags?: string[]; notes?: string; [k: string]: unknown };

export async function startConvert(pool: Pool, tenantId: string, designId: string, messageId: string): Promise<void> {
  const m = await pool.query<{ desktop_path: string | null; mobile_path: string | null }>(
    `SELECT m.desktop_path, m.mobile_path FROM email_design_messages m JOIN email_designs d ON d.id = m.design_id
      WHERE m.id = $1::uuid AND m.design_id = $2::uuid AND d.tenant_id = $3::uuid AND m.role = 'ai' AND m.status = 'done'`,
    [messageId, designId, tenantId],
  );
  const row = m.rows[0];
  if (!row) throw new Error("Pick a finished version to convert");
  if (!row.desktop_path || !row.mobile_path) throw new Error("This version is missing its desktop or phone picture");
  const r = await pool.query(
    `UPDATE email_designs SET status = 'converting', chosen_message = $2::uuid, convert_error = NULL, convert_started_at = now(), updated_at = now()
      WHERE id = $1::uuid AND status <> 'converting'`,
    [designId, messageId],
  );
  if (!r.rowCount) throw new Error("This design is already being converted");
}

/** Called by the tick: convert one design at a time. */
export async function runConversions(pool: Pool, log: (m: string) => void = console.log): Promise<number> {
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('carbon_email_convert')) AS ok`);
    if (!got.rows[0]?.ok) return 0;
    // Cut off by a restart: the OpenAI container files are gone, so start over.
    await pool.query(
      `UPDATE email_designs SET status = 'failed', convert_error = 'Interrupted (the server restarted). Press Convert to email again.'
        WHERE status = 'converting' AND convert_started_at < now() - interval '30 minutes'`,
    );
    const d = await pool.query<{ id: string; chosen_message: string }>(
      `SELECT id::text, chosen_message::text FROM email_designs WHERE status = 'converting' AND manifest IS DISTINCT FROM '{"_running": true}'::jsonb ORDER BY convert_started_at LIMIT 1`,
    );
    const job = d.rows[0];
    if (!job) return 0;
    await pool.query(`UPDATE email_designs SET manifest = '{"_running": true}'::jsonb WHERE id = $1::uuid`, [job.id]);
    try {
      await convertOne(pool, job.id, job.chosen_message, log);
      return 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[email-convert] ${job.id} failed: ${msg}`);
      await pool.query(`UPDATE email_designs SET status = 'failed', convert_error = $2, manifest = NULL, updated_at = now() WHERE id = $1::uuid`, [job.id, msg.slice(0, 800)]);
      return 0;
    }
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('carbon_email_convert'))`).catch(() => {});
    lock.release();
  }
}

async function convertOne(pool: Pool, designId: string, messageId: string, log: (m: string) => void): Promise<void> {
  const m = await pool.query<{ desktop_path: string; mobile_path: string; products: TurnProduct[] | null }>(`SELECT desktop_path, mobile_path, products FROM email_design_messages WHERE id = $1::uuid`, [messageId]);
  const row = m.rows[0];
  const ai = openai();
  const desk = Buffer.from((await downloadStorageObject(row.desktop_path)).body);
  const mob = Buffer.from((await downloadStorageObject(row.mobile_path)).body);
  const fDesk = await ai.files.create({ file: await toFile(desk, "design-desktop.png", { type: "image/png" }), purpose: "user_data" });
  const fMob = await ai.files.create({ file: await toFile(mob, "design-mobile.png", { type: "image/png" }), purpose: "user_data" });
  try {
    log(`[email-convert] ${designId}: OpenAI is cutting the pictures and writing the email`);
    const resp = await ai.responses.create({
      model: textModel(),
      tools: [{ type: "code_interpreter", container: { type: "auto", file_ids: [fDesk.id, fMob.id], memory_limit: "4g" } }],
      tool_choice: "required",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: convertInstructions("design-desktop.png", "design-mobile.png", row.products ?? []) },
            { type: "input_image", file_id: fDesk.id, detail: "high" },
            { type: "input_image", file_id: fMob.id, detail: "high" },
          ],
        },
      ],
    });
    const containerId =
      resp.output.map((o) => (o.type === "code_interpreter_call" ? (o as { container_id?: string }).container_id : undefined)).find(Boolean) ?? null;
    if (!containerId) throw new Error("OpenAI did not run the conversion (no code was executed)");
    const files = await ai.containers.files.list(containerId, { limit: 100 });
    const zipFile = files.data.filter((f) => /email-package\.zip$/.test(f.path)).at(-1);
    if (!zipFile) throw new Error("OpenAI did not produce email-package.zip");
    const res = await ai.containers.files.content.retrieve(zipFile.id, { container_id: containerId });
    const zipBytes = Buffer.from(await res.arrayBuffer());
    await ingestPackage(pool, designId, zipBytes, log);
  } finally {
    await ai.files.delete(fDesk.id).catch(() => {});
    await ai.files.delete(fMob.id).catch(() => {});
  }
}

export function mediaUrl(path: string): string {
  return `${WMS_BASE}/api/public/email-media/${path.replace(/^email\//, "")}`;
}

/** Unpack, check, host and store a package (also used when the owner uploads a zip by hand). */
export async function ingestPackage(pool: Pool, designId: string, zipBytes: Buffer, log: (m: string) => void = console.log): Promise<{ images: number; notes: string | null }> {
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > MAX_FILES) throw new Error(`The package has ${entries.length} files (max ${MAX_FILES})`);
  // The package may or may not have a top folder ("package/…").
  const htmlEntry = entries.find((f) => /(^|\/)email\.html$/i.test(f.name));
  if (!htmlEntry) throw new Error("The package has no email.html");
  const root = htmlEntry.name.replace(/email\.html$/i, "");
  let total = 0;
  const stamp = Date.now().toString(36);
  const prefix = `email/designs/${designId}/v-${stamp}`;
  const hosted = new Map<string, string>();
  for (const f of entries) {
    if (!f.name.startsWith(root)) continue;
    const rel = f.name.slice(root.length);
    if (!/^images\/[A-Za-z0-9._-]+\.(jpe?g|png|gif|webp)$/i.test(rel)) continue;
    const buf = await f.async("nodebuffer");
    total += buf.length;
    if (total > MAX_UNZIPPED) throw new Error("The package pictures are too large");
    const meta = await sharp(buf).metadata().catch(() => null);
    if (!meta?.width || !meta.height) {
      log(`[email-convert] skipped ${rel}: not a picture`);
      continue;
    }
    const name = rel.slice("images/".length).replace(/\.(jpe?g|webp)$/i, ".jpg").replace(/\.gif$/i, ".png");
    const isPng = name.toLowerCase().endsWith(".png");
    const out = isPng
      ? await sharp(buf).resize({ width: 1200, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()
      : await sharp(buf).flatten({ background: "#ffffff" }).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    const path = `${prefix}/${name}`;
    await uploadBytesToStorage({ path, bytes: out, contentType: isPng ? "image/png" : "image/jpeg" });
    hosted.set(rel, mediaUrl(path));
    hosted.set(`./${rel}`, mediaUrl(path));
  }
  let html = await htmlEntry.async("string");
  html = html.replace(/(src|background)\s*=\s*(["'])([^"']+)\2/gi, (all, attr: string, q: string, url: string) => {
    const u = hosted.get(url.trim());
    if (u) return `${attr}=${q}${u}${q}`;
    if (/^(https?:|cid:|\{\{)/i.test(url.trim())) return all;
    return attr.toLowerCase() === "src" ? `${attr}=${q}${q} data-missing="${url.replace(/"/g, "")}"` : "";
  });
  html = html.replace(/url\(\s*(["']?)(images\/[^"')]+)\1\s*\)/gi, (all, _q: string, url: string) => (hosted.get(url) ? `url('${hosted.get(url)}')` : "none"));
  html = sanitizeEmailHtml(html);
  if (!/<table/i.test(html)) throw new Error("The email OpenAI wrote has no table layout; convert again");
  let manifest: Manifest = {};
  const mEntry = entries.find((f) => f.name === `${root}manifest.json`);
  if (mEntry) manifest = (JSON.parse(await mEntry.async("string").catch(() => "{}")) as Manifest) ?? {};
  // Left-over sample values mean a personal part was not turned into a merge tag.
  const leftovers = [SAMPLE_CODE, `Hi ${SAMPLE_NAME}`, `${SAMPLE_NAME},`].filter((s) => html.includes(s));
  html = html.split(SAMPLE_CODE).join("{{code}}").replace(new RegExp(`\\b${SAMPLE_NAME}\\b`, "g"), "{{greeting_name}}");
  const zipPath = `${prefix}/email-package.zip`;
  await uploadBytesToStorage({ path: zipPath, bytes: zipBytes, contentType: "application/zip" });
  const notes = [manifest.notes ? String(manifest.notes) : "", leftovers.length ? `Fixed by CarbonWMS: ${leftovers.join(", ")} became merge tags.` : ""].filter(Boolean).join(" ") || null;
  await pool.query(
    `UPDATE email_designs SET status = 'ready', html = $2, manifest = $3, package_path = $4, convert_error = NULL,
            subject_hint = COALESCE(NULLIF($5, ''), subject_hint), preheader_hint = COALESCE(NULLIF($6, ''), preheader_hint), updated_at = now()
      WHERE id = $1::uuid`,
    [designId, html, JSON.stringify({ ...manifest, notes, merge_tags: usedMergeTags(html), images: hosted.size / 2 }), zipPath, String(manifest.subject ?? "").slice(0, 120), String(manifest.preheader ?? "").slice(0, 200)],
  );
  log(`[email-convert] ${designId}: ready (${hosted.size / 2} pictures)`);
  return { images: hosted.size / 2, notes };
}
