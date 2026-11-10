/**
 * CarbonWMS Email — saved segments (phase 5). A segment is a name and rules (lib/email-editor/segments.ts);
 * its people are counted live from the contacts, the order history (Shopify + Carbon POS) and the
 * email events. A campaign copies the rules in (audience.segment) and freezes its list at approval.
 */
import type { Pool } from "pg";
import { isRules, type SegRule } from "@/lib/email-editor/segments";
import { audienceCount, type Audience } from "./contacts";

export type SegmentRow = { id: string; name: string; rules: SegRule[]; created_at: string; updated_at: string };

export async function listSegments(pool: Pool, tenantId: string): Promise<(SegmentRow & { count: number | null })[]> {
  const r = await pool.query<SegmentRow>(
    `SELECT id::text, name, rules, created_at, updated_at FROM email_segments WHERE tenant_id = $1::uuid AND archived_at IS NULL ORDER BY name`,
    [tenantId],
  );
  return Promise.all(r.rows.map(async (s) => ({ ...s, count: await segmentCount(pool, tenantId, s.rules).catch(() => null) })));
}

export async function segmentCount(pool: Pool, tenantId: string, rules: SegRule[], who: Audience["who"] = "all"): Promise<number> {
  return audienceCount(pool, tenantId, { who, segment: { id: "", name: "", rules } });
}

/** A few people in it (the builder's "who is this"). */
export async function segmentSample(pool: Pool, tenantId: string, rules: SegRule[]): Promise<{ email: string; first_name: string | null }[]> {
  const { audienceSql } = await import("./contacts");
  const q = audienceSql({ who: "all", segment: { id: "", name: "", rules } }, 2);
  const r = await pool.query<{ email: string; first_name: string | null }>(
    `SELECT c.email, c.first_name FROM email_contacts c WHERE c.tenant_id = $1::uuid AND ${q.where} ORDER BY c.customer_since DESC NULLS LAST LIMIT 8`,
    [tenantId, ...q.params],
  );
  return r.rows;
}

function check(name: unknown, rules: unknown): { name: string; rules: SegRule[] } {
  const n = typeof name === "string" ? name.trim().slice(0, 80) : "";
  if (!n) throw new Error("Give the segment a name");
  if (!isRules(rules) || !rules.length) throw new Error("Add at least one rule");
  return { name: n, rules };
}

export async function saveSegment(pool: Pool, tenantId: string, by: string | null, input: { id?: string; name: unknown; rules: unknown }): Promise<string> {
  const { name, rules } = check(input.name, input.rules);
  if (input.id) {
    const r = await pool.query(`UPDATE email_segments SET name = $3, rules = $4, updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`, [
      input.id,
      tenantId,
      name,
      JSON.stringify(rules),
    ]);
    if (!r.rowCount) throw new Error("Segment not found");
    return input.id;
  }
  const r = await pool.query<{ id: string }>(`INSERT INTO email_segments (tenant_id, name, rules, created_by) VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`, [tenantId, name, JSON.stringify(rules), by]);
  return r.rows[0].id;
}

export async function deleteSegment(pool: Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(`UPDATE email_segments SET archived_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenantId]);
}
