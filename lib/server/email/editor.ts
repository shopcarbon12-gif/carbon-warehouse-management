/**
 * CarbonWMS Email — the drag-and-drop editor's server side (owner, 2026-11-09: Klaviyo's editor).
 *
 * An editor email is an email_designs row with editor_doc set. Saving renders the data into the
 * design's html (the same column the AI Designer's "Convert to email" fills), so campaigns, test
 * sends, previews and translations work without knowing where the email came from. A changed email
 * drops its old Spanish/Portuguese copies (they no longer match); "Translate" makes new ones.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { uploadBytesToStorage } from "@/lib/storageProvider";
import { renderEmail, BG_MARK } from "@/lib/email-editor/render";
import { STARTERS } from "@/lib/email-editor/prebuilt";
import { blankDoc, isDoc, LOGO, type EmailDoc, type ProductItem } from "@/lib/email-editor/types";
import { sanitizeEmailHtml } from "./rules";
import { WMS_BASE } from "./config";
import { mediaLibrary } from "./brand";
import { catalogSets, inStockCatalog } from "./catalog";

export type EditorEmail = {
  id: string;
  title: string;
  doc: EmailDoc;
  subject: string;
  preheader: string;
  translate_status: string | null;
  has_es: boolean;
  has_pt: boolean;
  updated_at: string;
};

/** The email's HTML for sending (sanitized; the page colour mark kept for the footer). */
export function editorHtml(doc: EmailDoc): string {
  const html = sanitizeEmailHtml(renderEmail(doc));
  return html.replace(/<body([^>]*)>/i, (m) => `${m}${BG_MARK(doc.styles.pageBg)}`);
}

export async function createEditorEmail(pool: Pool, tenantId: string, by: string | null, input: { title?: string; starter?: string; fromId?: string }): Promise<string> {
  let doc: EmailDoc = blankDoc();
  let title = input.title?.trim() || "New email";
  let subject = "";
  let preheader = "";
  if (input.fromId) {
    const src = await getEditorEmail(pool, tenantId, input.fromId);
    if (!src) throw new Error("Email not found");
    doc = src.doc;
    title = input.title?.trim() || `${src.title} (copy)`;
    subject = src.subject;
    preheader = src.preheader;
  } else if (input.starter) {
    const st = STARTERS.find((x) => x.id === input.starter);
    if (st) {
      doc = st.make();
      if (!input.title) title = st.id === "blank" ? "New email" : st.name;
    }
  }
  const r = await pool.query<{ id: string }>(
    `INSERT INTO email_designs (tenant_id, title, status, editor_doc, html, subject_hint, preheader_hint, created_by)
     VALUES ($1::uuid, $2, 'ready', $3, $4, $5, $6, $7) RETURNING id::text`,
    [tenantId, title.slice(0, 80), JSON.stringify(doc), editorHtml(doc), subject, preheader, by],
  );
  return r.rows[0].id;
}

export async function getEditorEmail(pool: Pool, tenantId: string, id: string): Promise<EditorEmail | null> {
  const r = await pool.query<{ id: string; title: string; editor_doc: unknown; subject_hint: string | null; preheader_hint: string | null; translate_status: string | null; has_es: boolean; has_pt: boolean; updated_at: Date }>(
    `SELECT id::text, title, editor_doc, subject_hint, preheader_hint, translate_status, html_es IS NOT NULL AS has_es, html_pt IS NOT NULL AS has_pt, updated_at
       FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid AND editor_doc IS NOT NULL AND archived_at IS NULL`,
    [id, tenantId],
  );
  const row = r.rows[0];
  if (!row || !isDoc(row.editor_doc)) return null;
  return {
    id: row.id,
    title: row.title,
    doc: row.editor_doc,
    subject: row.subject_hint ?? "",
    preheader: row.preheader_hint ?? "",
    translate_status: row.translate_status,
    has_es: row.has_es,
    has_pt: row.has_pt,
    updated_at: row.updated_at.toISOString(),
  };
}

/** Save (autosave): render, store; a version is kept on leaving the editor and at most every 10 minutes. */
export async function saveEditorEmail(
  pool: Pool,
  tenantId: string,
  id: string,
  input: { doc: EmailDoc; title?: string; subject?: string; preheader?: string; snapshot?: boolean },
  by: string | null,
): Promise<{ updated_at: string; translationsDropped: boolean }> {
  if (!isDoc(input.doc)) throw new Error("Invalid email");
  const html = editorHtml(input.doc);
  if (html.length > 900_000) throw new Error("The email is too big");
  const r = await pool.query<{ updated_at: Date; dropped: boolean }>(
    `WITH old AS (SELECT html, html_es IS NOT NULL OR html_pt IS NOT NULL AS had FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid AND editor_doc IS NOT NULL)
     UPDATE email_designs d SET editor_doc = $3, html = $4,
            title = COALESCE($5, d.title), subject_hint = COALESCE($6, d.subject_hint), preheader_hint = COALESCE($7, d.preheader_hint),
            html_es = CASE WHEN old.html IS DISTINCT FROM $4 THEN NULL ELSE d.html_es END,
            html_pt = CASE WHEN old.html IS DISTINCT FROM $4 THEN NULL ELSE d.html_pt END,
            translate_status = CASE WHEN old.html IS DISTINCT FROM $4 THEN NULL ELSE d.translate_status END,
            status = 'ready', updated_at = now()
       FROM old WHERE d.id = $1::uuid
     RETURNING d.updated_at, (old.html IS DISTINCT FROM $4 AND old.had) AS dropped`,
    [id, tenantId, JSON.stringify(input.doc), html, input.title?.trim().slice(0, 80) || null, input.subject ?? null, input.preheader ?? null],
  );
  if (!r.rows[0]) throw new Error("Email not found");
  const last = await pool.query<{ age: number }>(`SELECT EXTRACT(EPOCH FROM now() - max(created_at))::int AS age FROM email_design_versions WHERE design_id = $1::uuid`, [id]);
  const age = last.rows[0]?.age;
  if (input.snapshot || age == null || age > 600) {
    await pool.query(`INSERT INTO email_design_versions (design_id, doc, title, created_by) VALUES ($1::uuid, $2, $3, $4)`, [id, JSON.stringify(input.doc), input.title ?? null, by]);
    await pool.query(
      `DELETE FROM email_design_versions WHERE design_id = $1::uuid AND id NOT IN (SELECT id FROM email_design_versions WHERE design_id = $1::uuid ORDER BY created_at DESC LIMIT 60)`,
      [id],
    );
  }
  return { updated_at: r.rows[0].updated_at.toISOString(), translationsDropped: r.rows[0].dropped };
}

export async function listVersions(pool: Pool, tenantId: string, id: string) {
  const r = await pool.query<{ id: string; created_at: Date; created_by: string | null; doc: unknown }>(
    `SELECT v.id::text, v.created_at, v.created_by, v.doc FROM email_design_versions v JOIN email_designs d ON d.id = v.design_id
      WHERE v.design_id = $1::uuid AND d.tenant_id = $2::uuid ORDER BY v.created_at DESC LIMIT 60`,
    [id, tenantId],
  );
  return r.rows.filter((v) => isDoc(v.doc)).map((v) => ({ id: v.id, at: v.created_at.toISOString(), by: v.created_by, doc: v.doc as EmailDoc }));
}

/* --------------------------------------------------------------- pictures */

export type LibraryImage = { url: string; name: string; width: number | null; height: number | null; kind: "upload" | "brand" | "store" | "logo" };

export async function uploadImage(pool: Pool, tenantId: string, by: string | null, file: { name: string; bytes: Buffer }): Promise<LibraryImage> {
  const meta = await sharp(file.bytes, { animated: true }).metadata().catch(() => null);
  if (!meta?.format || !["jpeg", "png", "gif", "webp", "heif", "avif"].includes(meta.format)) throw new Error("That file is not a picture (use JPG, PNG, GIF or WEBP)");
  const id = randomUUID();
  let out: Buffer;
  let ext: "jpg" | "png" | "gif";
  if (meta.format === "gif") {
    out = file.bytes;
    ext = "gif";
  } else if (meta.format === "png" && meta.hasAlpha) {
    out = await sharp(file.bytes).rotate().resize({ width: 1200, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    ext = "png";
  } else {
    out = await sharp(file.bytes).rotate().resize({ width: 1200, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    ext = "jpg";
  }
  const m = await sharp(out).metadata();
  const path = `email/uploads/${id}.${ext}`;
  await uploadBytesToStorage({ path, bytes: out, contentType: ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg" });
  const url = `${WMS_BASE}/api/public/email-media/uploads/${id}.${ext}`;
  const name = file.name.replace(/[^\w .()-]+/g, "").slice(0, 120) || `picture.${ext}`;
  await pool.query(`INSERT INTO email_uploads (id, tenant_id, name, path, url, width, height, bytes, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`, [
    id,
    tenantId,
    name,
    path,
    url,
    m.width ?? null,
    m.height ?? null,
    out.length,
    by,
  ]);
  return { url, name, width: m.width ?? null, height: m.height ?? null, kind: "upload" };
}

export async function imageLibrary(pool: Pool, tenantId: string): Promise<LibraryImage[]> {
  const up = await pool.query<{ url: string; name: string; width: number | null; height: number | null }>(
    `SELECT url, name, width, height FROM email_uploads WHERE tenant_id = $1::uuid AND archived_at IS NULL ORDER BY created_at DESC LIMIT 300`,
    [tenantId],
  );
  const brand = await mediaLibrary(pool, 200);
  return [
    ...up.rows.map((x) => ({ ...x, kind: "upload" as const })),
    { url: LOGO.black, name: "CARBON logo, black", width: 1200, height: 358, kind: "logo" as const },
    { url: LOGO.white, name: "CARBON logo, white", width: 1200, height: 358, kind: "logo" as const },
    ...brand.map((m) => ({ url: m.url, name: m.description.slice(0, 90), width: m.width, height: m.height, kind: m.kind === "store" ? ("store" as const) : ("brand" as const) })),
  ];
}

/* ---------------------------------------------------------------- products */

export type PickProduct = ProductItem & { gender: string; type: string; stock: number; created: number };

/** Every in-stock product (newest first) plus the matching sets as one card each. */
export async function editorCatalog(): Promise<{ products: PickProduct[]; sets: PickProduct[] }> {
  const items = await inStockCatalog();
  const products: PickProduct[] = items.map((p, i) => ({
    id: p.id,
    title: p.title,
    price: p.price,
    compareAt: p.compareAt,
    image: p.image,
    url: p.url,
    set: null,
    gender: p.gender,
    type: p.type,
    stock: p.stock,
    created: i,
  }));
  const sets: PickProduct[] = catalogSets(items).map((s, i) => ({
    id: `set:${s.lead.id}`,
    title: s.name,
    price: s.total,
    compareAt: null,
    image: s.lead.image,
    url: s.lead.url,
    set: { line: s.piecesLine, total: s.total, pieces: s.pieces.length },
    gender: s.lead.gender,
    type: "Set",
    stock: Math.min(...s.pieces.map((x) => x.stock)),
    created: i,
  }));
  return { products, sets };
}
