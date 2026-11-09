/**
 * CarbonWMS Email Editor, phase 2 (owner, 2026-11-09: Klaviyo's templates, saved blocks, brand kit).
 *
 *   Templates      a whole email saved under a name; "New email" can start from it.
 *   Saved sections one section saved under a name; the editor's Add content → Saved inserts a copy.
 *   Brand kit      one per store: the styles new blank emails start with + the brand colours.
 *
 * Saved items are copies: changing a saved section later does not change emails that already use
 * it (Klaviyo's "universal blocks" sync is not copied: editing one place silently changing sent and
 * scheduled emails is risky for a small team).
 */
import type { Pool } from "pg";
import { cloneSection, isDoc, isKit, type BrandKit, type EmailDoc, type Section } from "@/lib/email-editor/types";

export type SavedKind = "template" | "section";
export type SavedItem = { id: string; kind: SavedKind; name: string; created_at: string; created_by: string | null; data: EmailDoc | Section };

const MAX_BYTES = 600_000;

function isSection(x: unknown): x is Section {
  const s = x as Section;
  return !!s && typeof s === "object" && Array.isArray(s.cols) && s.cols.length >= 1 && s.cols.length <= 4 && s.cols.every((c) => Array.isArray(c?.blocks));
}

export async function listSaved(pool: Pool, tenantId: string, kind?: SavedKind): Promise<SavedItem[]> {
  const r = await pool.query<{ id: string; kind: SavedKind; name: string; created_at: Date; created_by: string | null; data: unknown }>(
    `SELECT id::text, kind, name, created_at, created_by, data FROM email_saved
      WHERE tenant_id = $1::uuid AND archived_at IS NULL AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC LIMIT 300`,
    [tenantId, kind ?? null],
  );
  return r.rows
    .filter((x) => (x.kind === "template" ? isDoc(x.data) : isSection(x.data)))
    .map((x) => ({ id: x.id, kind: x.kind, name: x.name, created_at: x.created_at.toISOString(), created_by: x.created_by, data: x.data as EmailDoc | Section }));
}

export async function saveItem(pool: Pool, tenantId: string, by: string | null, input: { kind: SavedKind; name: string; data: unknown }): Promise<string> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Give it a name");
  if (input.kind === "template" ? !isDoc(input.data) : !isSection(input.data)) throw new Error(input.kind === "template" ? "Invalid email" : "Invalid section");
  // Saved with fresh ids, so a copy never shares ids with the email it came from.
  const data = input.kind === "section" ? cloneSection(input.data as Section) : { ...(input.data as EmailDoc), sections: (input.data as EmailDoc).sections.map(cloneSection) };
  const json = JSON.stringify(data);
  if (json.length > MAX_BYTES) throw new Error("It is too big to save");
  const r = await pool.query<{ id: string }>(`INSERT INTO email_saved (tenant_id, kind, name, data, created_by) VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id::text`, [tenantId, input.kind, name, json, by]);
  return r.rows[0].id;
}

export async function renameItem(pool: Pool, tenantId: string, id: string, name: string): Promise<boolean> {
  const n = name.trim().slice(0, 80);
  if (!n) throw new Error("Give it a name");
  const r = await pool.query(`UPDATE email_saved SET name = $3 WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`, [id, tenantId, n]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteItem(pool: Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`UPDATE email_saved SET archived_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`, [id, tenantId]);
  return (r.rowCount ?? 0) > 0;
}

/** A template as a new email's starting point (fresh ids). */
export async function templateDoc(pool: Pool, tenantId: string, id: string): Promise<{ name: string; doc: EmailDoc } | null> {
  const r = await pool.query<{ name: string; data: unknown }>(`SELECT name, data FROM email_saved WHERE id = $1::uuid AND tenant_id = $2::uuid AND kind = 'template' AND archived_at IS NULL`, [id, tenantId]);
  const row = r.rows[0];
  if (!row || !isDoc(row.data)) return null;
  return { name: row.name, doc: { ...row.data, sections: row.data.sections.map(cloneSection) } };
}

/* --------------------------------------------------------------- brand kit */

export async function getKit(pool: Pool, tenantId: string): Promise<(BrandKit & { updated_at: string; updated_by: string | null }) | null> {
  const r = await pool.query<{ kit: unknown; updated_at: Date; updated_by: string | null }>(`SELECT kit, updated_at, updated_by FROM email_brand_kit WHERE tenant_id = $1::uuid`, [tenantId]).catch(() => ({ rows: [] }));
  const row = r.rows[0];
  if (!row || !isKit(row.kit)) return null;
  return { ...row.kit, updated_at: row.updated_at.toISOString(), updated_by: row.updated_by };
}

export async function saveKit(pool: Pool, tenantId: string, by: string | null, kit: unknown): Promise<void> {
  if (!isKit(kit)) throw new Error("Invalid brand kit");
  const clean: BrandKit = { styles: kit.styles, colors: [...new Set(kit.colors.map((c) => c.toUpperCase()))] };
  if (JSON.stringify(clean).length > 50_000) throw new Error("The brand kit is too big");
  await pool.query(
    `INSERT INTO email_brand_kit (tenant_id, kit, updated_by) VALUES ($1::uuid, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET kit = EXCLUDED.kit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, JSON.stringify(clean), by],
  );
}
