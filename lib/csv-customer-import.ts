import type { PoolClient } from "pg";
import { getPool } from "./db";

/**
 * Bulk customer importer for the WMS Loyalty → Members surface.
 * Mirrors Carbon-Loyalty/lib/csv-import.ts — kept in step manually
 * because the two services share no monorepo. Stamps:
 *
 *   created_via       = 'wms_csv'
 *   created_by_user_id = WMS user id
 *   pos_location_id    = optional, picked at upload time
 *
 * No "balance" credit path here — WMS doesn't write loyalty_ledger
 * (that's the loyalty service's job). For balance migrations use the
 * Carbon-Loyalty admin importer at /admin/customers/import.
 */
export type ParsedRow = {
  rowIndex: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  raw: Record<string, string>;
};

export type RowOutcome = {
  rowIndex: number;
  status: "matched" | "created" | "skipped" | "error";
  pos_customer_id?: number;
  message?: string;
  identity?: string;
};

export type ImportSummary = {
  total: number;
  matched: number;
  created: number;
  skipped: number;
  errors: number;
  outcomes: RowOutcome[];
};

const COL_ALIASES: Record<keyof ParsedRow, string[]> = {
  rowIndex:    [],
  first_name:  ["first_name", "firstname", "first name", "given name", "given_name"],
  last_name:   ["last_name", "lastname", "last name", "family name", "family_name", "surname"],
  email:       ["email", "e-mail", "email address"],
  phone:       ["phone", "mobile", "mobile phone", "mobile_phone", "phone number", "cell"],
  birthday:    ["birthday", "birth date", "birth_date", "dob", "date of birth"],
  raw:         [],
};

export function parseCsv(text: string): { headers: string[]; rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = splitCsv(text.replace(/\r\n/g, "\n"));
  if (lines.length === 0) return { headers: [], rows: [], errors: ["empty file"] };

  const headers = (lines[0] || []).map((h) => h.trim().toLowerCase());
  if (headers.length === 0) return { headers: [], rows: [], errors: ["no headers detected"] };

  const colMap: Partial<Record<keyof ParsedRow, number>> = {};
  for (const key of Object.keys(COL_ALIASES) as (keyof ParsedRow)[]) {
    const aliases = COL_ALIASES[key];
    if (!aliases.length) continue;
    const idx = headers.findIndex((h) => aliases.includes(h));
    if (idx >= 0) colMap[key] = idx;
  }
  if (colMap.email === undefined && colMap.phone === undefined) {
    errors.push("CSV must include an email or phone column");
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i];
    if (!cells || cells.every((c) => c.trim() === "")) continue;
    const get = (k: keyof ParsedRow) =>
      colMap[k] !== undefined ? (cells[colMap[k] as number] ?? "").trim() : "";
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => (raw[h] = (cells[j] ?? "").trim()));
    rows.push({
      rowIndex: i,
      first_name: get("first_name") || null,
      last_name: get("last_name") || null,
      email: normEmail(get("email")) || null,
      phone: normPhone(get("phone")) || null,
      birthday: normBirthday(get("birthday")) || null,
      raw,
    });
  }
  return { headers, rows, errors };
}

function splitCsv(s: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); out.push(cur); cur = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); out.push(cur); }
  return out;
}

const normEmail = (s: string) => s.toLowerCase().trim();
const normPhone = (s: string) => s.replace(/[^\d]/g, "");
function normBirthday(s: string): string {
  if (!s) return "";
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m1) return s;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) {
    const [, a, b, y] = m2;
    return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
  }
  return "";
}

export async function importRows(
  rows: ParsedRow[],
  opts: { actedByUserId: string; createdAtLocationId: number | null },
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    total: rows.length,
    matched: 0, created: 0, skipped: 0, errors: 0,
    outcomes: [],
  };

  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      try {
        const o = await upsertOne(client, row, opts);
        summary.outcomes.push(o);
        if (o.status === "matched") summary.matched++;
        if (o.status === "created") summary.created++;
        if (o.status === "skipped") summary.skipped++;
        if (o.status === "error") summary.errors++;
      } catch (err) {
        summary.errors++;
        summary.outcomes.push({
          rowIndex: row.rowIndex,
          status: "error",
          message: (err as Error).message ?? "unknown",
          identity: identityLabel(row),
        });
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return summary;
}

function identityLabel(r: ParsedRow): string {
  if (r.email) return r.email;
  if (r.phone) return r.phone;
  return [r.first_name, r.last_name].filter(Boolean).join(" ") || `row ${r.rowIndex}`;
}

async function upsertOne(
  client: PoolClient,
  row: ParsedRow,
  opts: { actedByUserId: string; createdAtLocationId: number | null },
): Promise<RowOutcome> {
  if (!row.email && !row.phone) {
    return {
      rowIndex: row.rowIndex,
      status: "skipped",
      message: "no email or phone — can't dedupe",
      identity: identityLabel(row),
    };
  }
  let matchId: number | null = null;
  if (row.email && row.phone) {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM pos_customers
        WHERE LOWER(email) = $1
          AND (regexp_replace(COALESCE(phone,''),   '[^0-9]', '', 'g') = $2
               OR regexp_replace(COALESCE(phone_2,''), '[^0-9]', '', 'g') = $2)
        LIMIT 1`,
      [row.email, row.phone],
    );
    matchId = r.rows[0]?.id ?? null;
  }
  if (!matchId && row.email) {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM pos_customers WHERE LOWER(email) = $1 LIMIT 1`,
      [row.email],
    );
    matchId = r.rows[0]?.id ?? null;
  }
  if (!matchId && row.phone) {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM pos_customers
        WHERE regexp_replace(COALESCE(phone,''),   '[^0-9]', '', 'g') = $1
           OR regexp_replace(COALESCE(phone_2,''), '[^0-9]', '', 'g') = $1
        LIMIT 1`,
      [row.phone],
    );
    matchId = r.rows[0]?.id ?? null;
  }

  if (matchId) {
    await client.query(
      `UPDATE pos_customers
          SET first_name   = COALESCE(first_name, $1),
              last_name    = COALESCE(last_name,  $2),
              email        = COALESCE(email,      $3),
              phone        = COALESCE(phone,      $4),
              birthday     = COALESCE(birthday,   $5::date)
        WHERE id = $6`,
      [row.first_name, row.last_name, row.email, row.phone, row.birthday, matchId],
    );
    return {
      rowIndex: row.rowIndex,
      status: "matched",
      pos_customer_id: matchId,
      identity: identityLabel(row),
    };
  }

  const ins = await client.query<{ id: number }>(
    `INSERT INTO pos_customers
       (first_name, last_name, email, phone, birthday,
        pos_location_id, created_by_user_id, created_via, created_at)
     VALUES ($1, $2, $3, $4, $5::date, $6::int, $7::uuid, 'wms_csv', now())
     RETURNING id`,
    [
      row.first_name,
      row.last_name,
      row.email,
      row.phone,
      row.birthday,
      opts.createdAtLocationId,
      opts.actedByUserId,
    ],
  );
  return {
    rowIndex: row.rowIndex,
    status: "created",
    pos_customer_id: ins.rows[0].id,
    identity: identityLabel(row),
  };
}
